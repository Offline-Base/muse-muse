// Muse Rover's microcontroller half (docs/ROVER.md). It owns the two motors, the pan-tilt servos, the wheel encoders and
// the three distance sensors, and offers them to the board's Linux side through arduino-router with Bridge.provide.
// A Bridge call only leaves a request for loop() or reads what loop() last saw. loop() sets every pin, except that the
// guard timer's interrupt may put the motor driver in standby.
//
// Two things here never wait on Linux. A drive ends by itself when its time is up, and while both wheels go forward the
// rover stops as soon as the front sensor sees anything closer than ROVER_STOP_MM. loop() does both every time round,
// right after it reads the front sensor, and the guard timer backs it up for when a stuck I2C bus holds loop() up (see
// "The guard"). Nothing on the rover runs a model.
//
// Pins and limits come from rover_config.h, which setup-rover.sh writes from ~/.muse-device/rover.json.

#include <Arduino_RouterBridge.h>
#include <Wire.h>
#include <stdarg.h>
#include <zephyr/kernel.h>

#include "rover_config.h"

#define ROVER_VERSION "muse-rover 1"

const int SPEED_MAX = 255;
const uint32_t SERVO_FRAME_MS = 20;
// A pulse this much longer than asked for was held up, most likely by the Bridge's thread. status() counts them.
const uint32_t SERVO_LATE_US = 50;
const uint32_t RANGE_POLL_MS = 10;
// A reading older than this is no reading. Each sensor makes one about every 33 ms.
const uint32_t RANGE_FRESH_MS = 300;
// Failed reads in a row before a sensor counts as gone, and how often a gone one is tried again while the rover is still.
const int RANGE_MISSES = 3;
const uint32_t SENSOR_RETRY_MS = 5000;
// How often the guard timer looks, and how late loop() may be to stop a drive before the guard stops it instead.
const int GUARD_PERIOD_MS = 10;
const uint32_t GUARD_GRACE_MS = 20;

enum { FRONT, LEFT_SIDE, RIGHT_SIDE, SENSORS };
const uint8_t SENSOR_ADDR[SENSORS] = {0x30, 0x31, 0x32};
const int XSHUT_PIN[SENSORS] = {ROVER_PIN_XSHUT_FRONT, ROVER_PIN_XSHUT_LEFT, ROVER_PIN_XSHUT_RIGHT};

// ---- What Bridge calls and loop() share ----------------------------------------------------------------------------
// Bridge calls run on the Bridge's own thread, so both sides take this lock, and only long enough to copy.

enum Motion { MOTION_NONE, MOTION_DRIVE, MOTION_STOP };

// What Bridge calls ask loop() to do. Only the newest motion counts: a stop sent after a drive wins, and so does a drive
// sent after a stop.
struct Request {
  Motion motion;
  int left, right, ms;
  bool look;
  int pan, tilt;
};

// What loop() last saw, for Bridge calls to answer from.
struct Snapshot {
  int range[SENSORS];
  bool present[SENSORS];
  bool driving;
  int left, right;
  uint32_t ms_left;
  int pan, tilt;
  bool servos_on;
  uint32_t late_pulses;
  char front_block[96];
  char last_stop[96];
};

static struct k_mutex shared_lock;
static Request request;
static Snapshot shared;

// ---- loop()'s own state ----------------------------------------------------------------------------------------------

static bool driving = false;
static int speed_left = 0, speed_right = 0, drive_ms = 0;
static uint32_t drive_until = 0;
static char last_stop[96] = "nothing has driven yet";
static int pan_deg = 0, tilt_deg = 0;
static uint32_t servo_until = 0, servo_frame_at = 0, late_pulses = 0;

struct Sensor {
  bool present;
  uint8_t stop_variable;
  int mm;
  volatile uint32_t read_at;  // the guard reads the front one's too
  int misses;
};
static Sensor sensors[SENSORS];
static uint32_t range_poll_at = 0, sensor_retry_at = 0;

// What loop() and the guard's interrupt share. loop() turns the guard off before it changes the rest. The interrupt only
// reads it, and when it stops a drive it turns the guard off and leaves loop() the reason.
enum GuardStop { GUARD_NONE, GUARD_TIME, GUARD_BLIND };
static struct k_timer guard_timer;
static volatile bool guard_on = false, guard_forward = false;
static volatile uint32_t guard_until = 0;
static volatile int guard_stop = GUARD_NONE;

// Each encoder gives one channel, which can't tell direction, so a tick counts the way its wheel was last driven.
static volatile int32_t ticks_left = 0, ticks_right = 0;
static volatile int8_t dir_left = 1, dir_right = 1;

static void on_tick_left() { ticks_left += dir_left; }
static void on_tick_right() { ticks_right += dir_right; }

// ---- Motors: a TB6612FNG, channel A left and B right ----------------------------------------------------------------

static void set_motor(int pwm, int in1, int in2, int speed) {
  if (speed > 0) {
    digitalWrite(in1, HIGH);
    digitalWrite(in2, LOW);
    analogWrite(pwm, speed);
  } else if (speed < 0) {
    digitalWrite(in1, LOW);
    digitalWrite(in2, HIGH);
    analogWrite(pwm, -speed);
  } else {
    // Both inputs high is the driver's short brake, which stops a wheel sooner than letting it coast.
    digitalWrite(in1, HIGH);
    digitalWrite(in2, HIGH);
    analogWrite(pwm, 0);
  }
}

static void set_wheels(int left, int right) {
  speed_left = left;
  speed_right = right;
  if (left) dir_left = left > 0 ? 1 : -1;
  if (right) dir_right = right > 0 ? 1 : -1;
  set_motor(ROVER_PIN_PWMA, ROVER_PIN_AIN1, ROVER_PIN_AIN2, ROVER_LEFT_INVERT ? -left : left);
  set_motor(ROVER_PIN_PWMB, ROVER_PIN_BIN1, ROVER_PIN_BIN2, ROVER_RIGHT_INVERT ? -right : right);
}

static void stop_wheels(const char* why) {
  guard_on = false;
  set_wheels(0, 0);
  // Out of standby again if the guard put the driver there, now that both inputs say brake.
  digitalWrite(ROVER_PIN_STBY, HIGH);
  driving = false;
  snprintf(last_stop, sizeof last_stop, "%s", why);
}

// ---- The guard -------------------------------------------------------------------------------------------------------
// loop() makes every stop itself, but only when it comes round, and a stuck I2C bus holds it up: this core's I2C driver
// waits 500 ms for a transfer that never ends, without bus recovery, so one poll of three sensors can take 1.5 s. So while
// a drive runs, a kernel timer looks every GUARD_PERIOD_MS, in an interrupt, at whether loop() is more than GUARD_GRACE_MS
// late to end it, or to stop a forward drive whose front reading went stale. If so it puts the TB6612 in standby, which
// lets both wheels go at once, and loop() brakes and says why when it gets going again. On this core digitalWrite is
// gpio_pin_set_dt and millis() is k_uptime_get_32, which an interrupt may both call.
//
// A microcontroller that halts stops the timer too. The sketch starts no hardware watchdog: docs/ROVER.md says why.

static void guard_check(struct k_timer*) {
  if (!guard_on) return;
  uint32_t now = millis();
  int stop = GUARD_NONE;
  if ((int32_t)(now - guard_until) >= (int32_t)GUARD_GRACE_MS) {
    stop = GUARD_TIME;
  } else if (ROVER_NEED_FRONT && guard_forward && now - sensors[FRONT].read_at > RANGE_FRESH_MS + GUARD_GRACE_MS) {
    stop = GUARD_BLIND;
  }
  if (stop == GUARD_NONE) return;
  digitalWrite(ROVER_PIN_STBY, LOW);
  guard_on = false;
  guard_stop = stop;
}

// A stop the guard made, braked and said from loop().
static void guard_said() {
  char why[96];
  if (guard_stop == GUARD_TIME) {
    snprintf(why, sizeof why, "the drive's %d ms were up while the microcontroller was held up, so its timer stopped it", drive_ms);
  } else {
    snprintf(why, sizeof why, "the front reading went stale while the microcontroller was held up, so its timer stopped it");
  }
  guard_stop = GUARD_NONE;
  stop_wheels(why);
}

// ---- Servos ----------------------------------------------------------------------------------------------------------
// The 50 Hz servo signal is made here, not by the core's PWM. analogWrite runs at the 500 Hz the board's overlay sets, and
// asking Zephyr's PWM API for a 20 ms period changes the period of the whole timer behind the pin, so any motor channel
// on the same timer with it, if the timer's 16 bits can even hold 20 ms at the prescaler the overlay chose. A pulse timed
// with micros() needs neither. It costs up to 2.5 ms of every 20, and only for ROVER_SERVO_HOLD_MS after each look, so
// a Bridge call that lands mid-pulse can't make a resting servo twitch.

static int servo_pulse_us(int deg, bool invert) {
  if (invert) deg = -deg;
  long span = ROVER_SERVO_MAX_US - ROVER_SERVO_MIN_US;
  long us = (ROVER_SERVO_MIN_US + ROVER_SERVO_MAX_US) / 2 + (long)deg * span / 180;
  return (int)constrain(us, (long)ROVER_SERVO_MIN_US, (long)ROVER_SERVO_MAX_US);
}

static bool servos_on(uint32_t now) {
  return ROVER_SERVO_HOLD_MS == 0 || (int32_t)(servo_until - now) > 0;
}

// Both pulses start together and each ends at its own width.
static void pulse_servos() {
  int pan_us = servo_pulse_us(pan_deg, ROVER_PAN_INVERT), tilt_us = servo_pulse_us(tilt_deg, ROVER_TILT_INVERT);
  bool pan_high = true, tilt_high = true;
  uint32_t start = micros();
  digitalWrite(ROVER_PIN_SERVO_PAN, HIGH);
  digitalWrite(ROVER_PIN_SERVO_TILT, HIGH);
  while (pan_high || tilt_high) {
    uint32_t elapsed = micros() - start;
    if (pan_high && elapsed >= (uint32_t)pan_us) {
      digitalWrite(ROVER_PIN_SERVO_PAN, LOW);
      pan_high = false;
      if (elapsed > (uint32_t)pan_us + SERVO_LATE_US) late_pulses++;
    }
    if (tilt_high && elapsed >= (uint32_t)tilt_us) {
      digitalWrite(ROVER_PIN_SERVO_TILT, LOW);
      tilt_high = false;
      if (elapsed > (uint32_t)tilt_us + SERVO_LATE_US) late_pulses++;
    }
  }
}

// ---- VL53L0X, register by register -----------------------------------------------------------------------------------
// The board has no VL53L0X library (STM32duino_VL53L4CD is for another sensor), and a library named in sketch.yaml would
// have to be downloaded when App Lab builds, along with every library the sketch already uses. So this is the sensor's
// bring-up as ST's VL53L0X API does it, which Pololu's VL53L0X library also follows, cut to continuous ranging over
// Wire: data init, reference SPADs, ST's default tuning, the VHV and phase calibrations, then back-to-back readings. It
// keeps the sensor's own timing budget, about 33 ms a reading, rather than working one out.

const uint8_t VL_DEFAULT_ADDR = 0x29;
const uint32_t VL_TIMEOUT_MS = 100;
const int VL_NOT_YET = -2, VL_FAILED = -3;

// Around each use of register 0x91, ST's API opens the sensor's private page and closes it after.
static const uint8_t VL_OPEN[][2] = {{0x80, 0x01}, {0xFF, 0x01}, {0x00, 0x00}};
static const uint8_t VL_CLOSE[][2] = {{0x00, 0x01}, {0xFF, 0x00}, {0x80, 0x00}};
// ST's DefaultTuningSettings (vl53l0x_tuning.h), as register and value.
static const uint8_t VL_TUNING[][2] = {
    {0xFF, 0x01}, {0x00, 0x00}, {0xFF, 0x00}, {0x09, 0x00}, {0x10, 0x00}, {0x11, 0x00}, {0x24, 0x01}, {0x25, 0xFF},
    {0x75, 0x00}, {0xFF, 0x01}, {0x4E, 0x2C}, {0x48, 0x00}, {0x30, 0x20}, {0xFF, 0x00}, {0x30, 0x09}, {0x54, 0x00},
    {0x31, 0x04}, {0x32, 0x03}, {0x40, 0x83}, {0x46, 0x25}, {0x60, 0x00}, {0x27, 0x00}, {0x50, 0x06}, {0x51, 0x00},
    {0x52, 0x96}, {0x56, 0x08}, {0x57, 0x30}, {0x61, 0x00}, {0x62, 0x00}, {0x64, 0x00}, {0x65, 0x00}, {0x66, 0xA0},
    {0xFF, 0x01}, {0x22, 0x32}, {0x47, 0x14}, {0x49, 0xFF}, {0x4A, 0x00}, {0xFF, 0x00}, {0x7A, 0x0A}, {0x7B, 0x00},
    {0x78, 0x21}, {0xFF, 0x01}, {0x23, 0x34}, {0x42, 0x00}, {0x44, 0xFF}, {0x45, 0x26}, {0x46, 0x05}, {0x40, 0x40},
    {0x0E, 0x06}, {0x20, 0x1A}, {0x43, 0x40}, {0xFF, 0x00}, {0x34, 0x03}, {0x35, 0x44}, {0xFF, 0x01}, {0x31, 0x04},
    {0x4B, 0x09}, {0x4C, 0x05}, {0x4D, 0x04}, {0xFF, 0x00}, {0x44, 0x00}, {0x45, 0x20}, {0x47, 0x08}, {0x48, 0x28},
    {0x67, 0x00}, {0x70, 0x04}, {0x71, 0x01}, {0x72, 0xFE}, {0x76, 0x00}, {0x77, 0x00}, {0xFF, 0x01}, {0x0D, 0x01},
    {0xFF, 0x00}, {0x80, 0x01}, {0x01, 0xF8}, {0xFF, 0x01}, {0x8E, 0x01}, {0x00, 0x01}, {0xFF, 0x00}, {0x80, 0x00},
};

static bool vl_write_block(uint8_t addr, uint8_t reg, const uint8_t* data, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  for (uint8_t i = 0; i < n; i++) Wire.write(data[i]);
  return Wire.endTransmission() == 0;
}

static bool vl_write(uint8_t addr, uint8_t reg, uint8_t value) { return vl_write_block(addr, reg, &value, 1); }

static bool vl_write16(uint8_t addr, uint8_t reg, uint16_t value) {
  uint8_t data[2] = {(uint8_t)(value >> 8), (uint8_t)(value & 0xFF)};
  return vl_write_block(addr, reg, data, 2);
}

static bool vl_writes(uint8_t addr, const uint8_t (*pairs)[2], size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (!vl_write(addr, pairs[i][0], pairs[i][1])) return false;
  }
  return true;
}

// The sensor takes a register index, then a separate read, so this never needs a repeated start.
static bool vl_read(uint8_t addr, uint8_t reg, uint8_t* out, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom(addr, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) out[i] = Wire.read();
  return true;
}

static bool vl_wait_set(uint8_t addr, uint8_t reg, uint8_t mask) {
  uint32_t start = millis();
  uint8_t value;
  do {
    if (!vl_read(addr, reg, &value, 1)) return false;
    if (value & mask) return true;
  } while (millis() - start < VL_TIMEOUT_MS);
  return false;
}

static bool vl_spad_info(uint8_t addr, uint8_t& count, bool& aperture) {
  uint8_t v;
  if (!vl_writes(addr, VL_OPEN, 3) || !vl_write(addr, 0xFF, 0x06) || !vl_read(addr, 0x83, &v, 1) || !vl_write(addr, 0x83, v | 0x04)) return false;
  if (!vl_write(addr, 0xFF, 0x07) || !vl_write(addr, 0x81, 0x01) || !vl_write(addr, 0x80, 0x01)) return false;
  if (!vl_write(addr, 0x94, 0x6B) || !vl_write(addr, 0x83, 0x00) || !vl_wait_set(addr, 0x83, 0xFF)) return false;
  if (!vl_write(addr, 0x83, 0x01) || !vl_read(addr, 0x92, &v, 1)) return false;
  count = v & 0x7F;
  aperture = (v >> 7) & 0x01;
  if (!vl_write(addr, 0x81, 0x00) || !vl_write(addr, 0xFF, 0x06) || !vl_read(addr, 0x83, &v, 1) || !vl_write(addr, 0x83, v & ~0x04)) return false;
  return vl_write(addr, 0xFF, 0x01) && vl_write(addr, 0x00, 0x01) && vl_write(addr, 0xFF, 0x00) && vl_write(addr, 0x80, 0x00);
}

// Keeps the first count good reference SPADs of the sensor's type, starting at 12 for aperture ones, and turns off the rest.
static bool vl_reference_spads(uint8_t addr) {
  uint8_t count, map[6];
  bool aperture;
  if (!vl_spad_info(addr, count, aperture) || !vl_read(addr, 0xB0, map, 6)) return false;
  if (!vl_write(addr, 0xFF, 0x01) || !vl_write(addr, 0x4F, 0x00) || !vl_write(addr, 0x4E, 0x2C) || !vl_write(addr, 0xFF, 0x00) || !vl_write(addr, 0xB6, 0xB4)) return false;
  uint8_t first = aperture ? 12 : 0, enabled = 0;
  for (uint8_t i = 0; i < 48; i++) {
    if (i < first || enabled == count) {
      map[i / 8] &= ~(1 << (i % 8));
    } else if ((map[i / 8] >> (i % 8)) & 0x01) {
      enabled++;
    }
  }
  return vl_write_block(addr, 0xB0, map, 6);
}

static bool vl_calibrate(uint8_t addr, uint8_t sequence, uint8_t vhv) {
  return vl_write(addr, 0x01, sequence) && vl_write(addr, 0x00, 0x01 | vhv) && vl_wait_set(addr, 0x13, 0x07) &&
         vl_write(addr, 0x0B, 0x01) && vl_write(addr, 0x00, 0x00);
}

static bool vl_init(uint8_t addr, uint8_t& stop_variable) {
  uint8_t v;
  // The model ID: anything else at this address isn't a VL53L0X.
  if (!vl_read(addr, 0xC0, &v, 1) || v != 0xEE) return false;
  // 2.8 V I/O, which is what the breakouts' own regulators give the sensor, then standard I2C mode.
  if (!vl_read(addr, 0x89, &v, 1) || !vl_write(addr, 0x89, v | 0x01) || !vl_write(addr, 0x88, 0x00)) return false;
  if (!vl_writes(addr, VL_OPEN, 3) || !vl_read(addr, 0x91, &stop_variable, 1) || !vl_writes(addr, VL_CLOSE, 3)) return false;
  // No signal rate checks on the MSRC and pre-range steps, and 0.25 MCPS (0x0020 in 9.7 fixed point) for the final range.
  if (!vl_read(addr, 0x60, &v, 1) || !vl_write(addr, 0x60, v | 0x12) || !vl_write16(addr, 0x44, 0x0020)) return false;
  if (!vl_write(addr, 0x01, 0xFF) || !vl_reference_spads(addr)) return false;
  if (!vl_writes(addr, VL_TUNING, sizeof VL_TUNING / sizeof VL_TUNING[0])) return false;
  // An interrupt on each new reading, active low, cleared to start.
  if (!vl_write(addr, 0x0A, 0x04) || !vl_read(addr, 0x84, &v, 1) || !vl_write(addr, 0x84, v & ~0x10) || !vl_write(addr, 0x0B, 0x01)) return false;
  // Ranging without the MSRC and TCC steps, around the VHV and phase calibrations.
  return vl_write(addr, 0x01, 0xE8) && vl_calibrate(addr, 0x01, 0x40) && vl_calibrate(addr, 0x02, 0x00) && vl_write(addr, 0x01, 0xE8);
}

static bool vl_start(uint8_t addr, uint8_t stop_variable) {
  return vl_writes(addr, VL_OPEN, 3) && vl_write(addr, 0x91, stop_variable) && vl_writes(addr, VL_CLOSE, 3) &&
         vl_write(addr, 0x00, 0x02);  // back to back
}

// A new reading in mm, VL_NOT_YET when the sensor hasn't finished one, or VL_FAILED when it didn't answer. With nothing
// in range it reads 8190 or so, which is far enough never to stop the rover.
static int vl_poll(uint8_t addr) {
  uint8_t status, raw[2];
  if (!vl_read(addr, 0x13, &status, 1)) return VL_FAILED;
  if (!(status & 0x07)) return VL_NOT_YET;
  if (!vl_read(addr, 0x1E, raw, 2) || !vl_write(addr, 0x0B, 0x01)) return VL_FAILED;
  return (raw[0] << 8) | raw[1];
}

static void hold_in_reset(int i) {
  pinMode(XSHUT_PIN[i], OUTPUT);
  digitalWrite(XSHUT_PIN[i], LOW);
}

// One sensor out of reset at the default address, moved to its own and ranging. Every other sensor is in reset or already
// moved, so this one is alone at 0x29.
static bool sensor_up(int i) {
  Sensor& s = sensors[i];
  hold_in_reset(i);
  delay(2);
  // Released with a pull-up rather than driven, so a breakout's own pull-up to 2.8 V decides, and one without a level
  // shifter never gets more than 3.3 V through the pin's resistor.
  pinMode(XSHUT_PIN[i], INPUT_PULLUP);
  delay(3);  // the sensor boots within 1.2 ms
  bool up = vl_write(VL_DEFAULT_ADDR, 0x8A, SENSOR_ADDR[i] & 0x7F) && vl_init(SENSOR_ADDR[i], s.stop_variable) &&
            vl_start(SENSOR_ADDR[i], s.stop_variable);
  if (!up) hold_in_reset(i);
  s.present = up;
  s.misses = 0;
  s.read_at = 0;
  s.mm = -1;
  return up;
}

static void poll_sensor(int i) {
  Sensor& s = sensors[i];
  if (!s.present) return;
  int mm = vl_poll(SENSOR_ADDR[i]);
  if (mm == VL_FAILED) {
    // Held in reset so it comes back at 0x29 alone, when it's tried again.
    if (++s.misses >= RANGE_MISSES) {
      s.present = false;
      hold_in_reset(i);
    }
    return;
  }
  s.misses = 0;
  if (mm != VL_NOT_YET) {
    s.mm = mm;
    // When the reading came, which a stuck bus can make well after loop() began.
    s.read_at = millis();
  }
}

// A sensor's distance in mm, or -1 when it's gone or its last reading is stale. A reading newer than now is fresh.
static int range_now(int i, uint32_t now) {
  const Sensor& s = sensors[i];
  return s.present && s.read_at && (int32_t)(now - s.read_at) <= (int32_t)RANGE_FRESH_MS ? s.mm : -1;
}

// Whether going forward is unsafe now, and why.
static bool front_blocks(uint32_t now, char* why, size_t size) {
  int mm = range_now(FRONT, now);
  if (mm < 0) {
    if (!ROVER_NEED_FRONT) return false;
    snprintf(why, size, "the front distance sensor isn't answering, so nothing would stop the rover");
    return true;
  }
  if (mm < ROVER_STOP_MM) {
    snprintf(why, size, "something is %d mm ahead, closer than the %d mm stop distance", mm, ROVER_STOP_MM);
    return true;
  }
  return false;
}

static void start_drive(int left, int right, int ms, uint32_t now) {
  char why[96];
  if (ms <= 0 || (left == 0 && right == 0)) {
    stop_wheels("a drive with no speed or no time");
    return;
  }
  if (left > 0 && right > 0 && front_blocks(now, why, sizeof why)) {
    stop_wheels(why);
    return;
  }
  // The guard off while its state changes. A stop it made of the drive this one replaces was said at the top of loop(),
  // unless it came in the microseconds since, and that one this drive replaces too.
  guard_on = false;
  set_wheels(left, right);
  digitalWrite(ROVER_PIN_STBY, HIGH);
  drive_ms = ms;
  drive_until = now + ms;
  driving = true;
  guard_until = drive_until;
  guard_forward = left > 0 && right > 0;
  guard_stop = GUARD_NONE;
  guard_on = true;
}

// The stops loop() makes every time round: one the guard made while loop() was held up, both wheels forward with
// something close in front, and the drive's time up.
static void check_drive(uint32_t now) {
  char why[96];
  if (guard_stop != GUARD_NONE) guard_said();
  if (driving && speed_left > 0 && speed_right > 0 && front_blocks(now, why, sizeof why)) stop_wheels(why);
  if (driving && (int32_t)(now - drive_until) >= 0) {
    snprintf(why, sizeof why, "the drive's %d ms were up", drive_ms);
    stop_wheels(why);
  }
}

static void publish(uint32_t now) {
  k_mutex_lock(&shared_lock, K_FOREVER);
  for (int i = 0; i < SENSORS; i++) {
    shared.present[i] = sensors[i].present;
    shared.range[i] = range_now(i, now);
  }
  shared.driving = driving;
  shared.left = speed_left;
  shared.right = speed_right;
  shared.ms_left = driving && (int32_t)(drive_until - now) > 0 ? drive_until - now : 0;
  shared.pan = pan_deg;
  shared.tilt = tilt_deg;
  shared.servos_on = servos_on(now);
  shared.late_pulses = late_pulses;
  if (!front_blocks(now, shared.front_block, sizeof shared.front_block)) shared.front_block[0] = '\0';
  snprintf(shared.last_stop, sizeof shared.last_stop, "%s", last_stop);
  k_mutex_unlock(&shared_lock);
}

// ---- Bridge calls ----------------------------------------------------------------------------------------------------
// Each answers with one line of JSON, which server.py reads. Every text in one is a fixed phrase without quotes. They run
// one at a time on the Bridge's thread, whose stack may be small, so the text and the status copy are static, not on it.

static String answer(const char* format, ...) {
  static char text[512];
  va_list args;
  va_start(args, format);
  vsnprintf(text, sizeof text, format, args);
  va_end(args);
  return String(text);
}

static const char* yes(bool value) { return value ? "true" : "false"; }

// Speeds from -255 to 255 a side, for ms (at most ROVER_MAX_DRIVE_MS), then the rover stops by itself.
static String rpc_drive(int left, int right, int ms) {
  left = constrain(left, -SPEED_MAX, SPEED_MAX);
  right = constrain(right, -SPEED_MAX, SPEED_MAX);
  ms = constrain(ms, 0, ROVER_MAX_DRIVE_MS);
  char why[96] = "";
  k_mutex_lock(&shared_lock, K_FOREVER);
  if (left > 0 && right > 0 && shared.front_block[0]) {
    snprintf(why, sizeof why, "%s", shared.front_block);
  } else {
    request.motion = MOTION_DRIVE;
    request.left = left;
    request.right = right;
    request.ms = ms;
  }
  k_mutex_unlock(&shared_lock);
  if (why[0]) return answer("{\"ok\":false,\"why\":\"%s\"}", why);
  return answer("{\"ok\":true,\"left\":%d,\"right\":%d,\"ms\":%d}", left, right, ms);
}

static String rpc_stop() {
  k_mutex_lock(&shared_lock, K_FOREVER);
  request.motion = MOTION_STOP;
  k_mutex_unlock(&shared_lock);
  return answer("{\"ok\":true}");
}

// Degrees from center: pan positive to the right, tilt positive up, each held to what rover_config.h allows.
static String rpc_look(int pan, int tilt) {
  pan = constrain(pan, ROVER_PAN_MIN_DEG, ROVER_PAN_MAX_DEG);
  tilt = constrain(tilt, ROVER_TILT_MIN_DEG, ROVER_TILT_MAX_DEG);
  k_mutex_lock(&shared_lock, K_FOREVER);
  request.look = true;
  request.pan = pan;
  request.tilt = tilt;
  k_mutex_unlock(&shared_lock);
  return answer("{\"ok\":true,\"pan\":%d,\"tilt\":%d}", pan, tilt);
}

// Distances in mm: -1 for a sensor that's gone or stale, about 8190 for nothing in range.
static String rpc_ranges() {
  k_mutex_lock(&shared_lock, K_FOREVER);
  int front = shared.range[FRONT], left = shared.range[LEFT_SIDE], right = shared.range[RIGHT_SIDE];
  k_mutex_unlock(&shared_lock);
  return answer("{\"front\":%d,\"left\":%d,\"right\":%d}", front, left, right);
}

static String rpc_ticks() {
  return answer("{\"left\":%ld,\"right\":%ld}", (long)ticks_left, (long)ticks_right);
}

static String rpc_status() {
  static Snapshot s;
  k_mutex_lock(&shared_lock, K_FOREVER);
  s = shared;
  k_mutex_unlock(&shared_lock);
  return answer(
      "{\"version\":\"%s\",\"driving\":%s,\"left\":%d,\"right\":%d,\"ms_left\":%lu,\"last_stop\":\"%s\",\"front_block\":\"%s\","
      "\"stop_mm\":%d,\"max_drive_ms\":%d,\"pan\":%d,\"tilt\":%d,\"servos_on\":%s,\"late_pulses\":%lu,"
      "\"sensors\":{\"front\":%s,\"left\":%s,\"right\":%s},\"uptime_ms\":%lu}",
      ROVER_VERSION, yes(s.driving), s.left, s.right, (unsigned long)s.ms_left, s.last_stop, s.front_block, ROVER_STOP_MM,
      ROVER_MAX_DRIVE_MS, s.pan, s.tilt, yes(s.servos_on), (unsigned long)s.late_pulses, yes(s.present[FRONT]),
      yes(s.present[LEFT_SIDE]), yes(s.present[RIGHT_SIDE]), (unsigned long)millis());
}

// ---- setup and loop --------------------------------------------------------------------------------------------------

void setup() {
  k_mutex_init(&shared_lock);

  // The driver leaves standby only once its inputs say brake. PWMA and PWMB get no pinMode: on this core that would take
  // the pin off its PWM timer, and analogWrite needs none.
  pinMode(ROVER_PIN_AIN1, OUTPUT);
  pinMode(ROVER_PIN_AIN2, OUTPUT);
  pinMode(ROVER_PIN_BIN1, OUTPUT);
  pinMode(ROVER_PIN_BIN2, OUTPUT);
  pinMode(ROVER_PIN_STBY, OUTPUT);
  digitalWrite(ROVER_PIN_STBY, LOW);
  set_wheels(0, 0);
  digitalWrite(ROVER_PIN_STBY, HIGH);
  // The guard runs from here on, and does nothing until a drive turns it on.
  k_timer_init(&guard_timer, guard_check, NULL);
  k_timer_start(&guard_timer, K_MSEC(GUARD_PERIOD_MS), K_MSEC(GUARD_PERIOD_MS));

  // Centered at power on, then resting.
  pinMode(ROVER_PIN_SERVO_PAN, OUTPUT);
  pinMode(ROVER_PIN_SERVO_TILT, OUTPUT);
  digitalWrite(ROVER_PIN_SERVO_PAN, LOW);
  digitalWrite(ROVER_PIN_SERVO_TILT, LOW);
  servo_until = millis() + ROVER_SERVO_HOLD_MS;

  pinMode(ROVER_PIN_ENC_LEFT, INPUT_PULLUP);
  pinMode(ROVER_PIN_ENC_RIGHT, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ROVER_PIN_ENC_LEFT), on_tick_left, RISING);
  attachInterrupt(digitalPinToInterrupt(ROVER_PIN_ENC_RIGHT), on_tick_right, RISING);

  // All three in reset, then up one at a time, each moved off 0x29 before the next wakes.
  for (int i = 0; i < SENSORS; i++) hold_in_reset(i);
  Wire.begin();
  Wire.setClock(400000);
  for (int i = 0; i < SENSORS; i++) sensor_up(i);
  publish(millis());

  Bridge.begin();
  Bridge.provide("drive", rpc_drive);
  Bridge.provide("stop", rpc_stop);
  Bridge.provide("look", rpc_look);
  Bridge.provide("ranges", rpc_ranges);
  Bridge.provide("ticks", rpc_ticks);
  Bridge.provide("status", rpc_status);
}

void loop() {
  uint32_t now = millis();
  Request wanted;
  k_mutex_lock(&shared_lock, K_FOREVER);
  wanted = request;
  request.motion = MOTION_NONE;
  request.look = false;
  k_mutex_unlock(&shared_lock);

  // A stop the guard made while the last time round was held up, said before anything new starts.
  if (guard_stop != GUARD_NONE) guard_said();
  if (wanted.motion == MOTION_STOP) stop_wheels("stop was called");
  if (wanted.motion == MOTION_DRIVE) start_drive(wanted.left, wanted.right, wanted.ms, now);
  if (wanted.look) {
    pan_deg = wanted.pan;
    tilt_deg = wanted.tilt;
    servo_until = now + ROVER_SERVO_HOLD_MS;
  }

  // The front sensor, then the safety stop and the time cap, then the sides, so their Wire calls hold up neither.
  bool poll = now - range_poll_at >= RANGE_POLL_MS;
  if (poll) {
    range_poll_at = now;
    poll_sensor(FRONT);
  }
  now = millis();
  check_drive(now);
  if (poll) {
    poll_sensor(LEFT_SIDE);
    poll_sensor(RIGHT_SIDE);
  }

  if (servos_on(now) && now - servo_frame_at >= SERVO_FRAME_MS) {
    servo_frame_at = now;
    pulse_servos();
  }

  // A sensor that went missing comes back once it answers again, tried only while the rover is still.
  if (!driving && now - sensor_retry_at >= SENSOR_RETRY_MS) {
    sensor_retry_at = now;
    for (int i = 0; i < SENSORS; i++) {
      if (!sensors[i].present) sensor_up(i);
    }
  }

  publish(millis());
  // Gives the Bridge's thread its turn, whatever its priority.
  delay(1);
}
