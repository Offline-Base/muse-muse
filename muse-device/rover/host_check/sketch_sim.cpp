// Runs sketch.ino's setup() and loop() on a computer, against a made-up clock, pins and three VL53L0X sensors on a
// made-up I2C bus, to check its logic: the bring-up at 0x30 to 0x32, the safety stop, the drive's time cap, refusals,
// the servo pulses and their rest, a sensor that stops answering, and the guard timer while a stuck bus holds loop() up.
// It proves nothing about the board's own APIs.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "Arduino.h"
#include "Wire.h"
#include "zephyr/kernel.h"
#include "Arduino_RouterBridge.h"

static uint64_t clock_us = 0;
static int pin_mode[64], pin_level[64], pin_pwm[64];
static uint64_t pin_high_at[64], pin_low_at[64];
static std::vector<std::pair<int, uint64_t>> pulses;  // (pin, width in us)

// The one timer the sketch starts, whose expiry runs as the clock passes each due time, as the kernel's clock interrupt
// would run it in the middle of whatever loop() is doing.
static k_timer* timer_on = nullptr;
void k_timer_init(struct k_timer* t, k_timer_expiry_t expiry, k_timer_stop_t) { t->expiry = expiry; }
void k_timer_start(struct k_timer* t, k_timeout_t duration, k_timeout_t period) {
  t->due_us = clock_us + (uint64_t)duration.ticks * 1000;
  t->period_ms = period.ticks;
  timer_on = t;
}
static void advance(uint64_t us) {
  uint64_t until = clock_us + us;
  while (timer_on && timer_on->due_us <= until) {
    k_timer* t = timer_on;
    if (t->due_us > clock_us) clock_us = t->due_us;
    if (t->period_ms) {
      t->due_us += (uint64_t)t->period_ms * 1000;
    } else {
      timer_on = nullptr;
    }
    t->expiry(t);
  }
  clock_us = until;
}

unsigned long millis() { return (unsigned long)(clock_us / 1000); }
unsigned long micros() {
  advance(1);
  return (unsigned long)clock_us;
}
void delay(unsigned long ms) { advance((uint64_t)ms * 1000); }
void pinMode(pin_size_t pin, PinMode mode) { pin_mode[pin] = mode; }
void digitalWrite(pin_size_t pin, PinStatus level) {
  if (level == HIGH && !pin_level[pin]) pin_high_at[pin] = clock_us;
  if (level == LOW && pin_level[pin]) {
    pulses.push_back({pin, clock_us - pin_high_at[pin]});
    pin_low_at[pin] = clock_us;
  }
  pin_level[pin] = level;
}
void analogWrite(pin_size_t pin, int value) { pin_pwm[pin] = value; }
static voidFuncPtr isr[64];
void attachInterrupt(pin_size_t pin, voidFuncPtr fn, PinStatus) { isr[pin] = fn; }
String::String(const char* s) : text(s) {}
int k_mutex_init(struct k_mutex*) { return 0; }
int k_mutex_lock(struct k_mutex*, k_timeout_t) { return 0; }
int k_mutex_unlock(struct k_mutex*) { return 0; }
bool BridgeClass::begin() { return true; }
BridgeClass Bridge;

// A VL53L0X: it answers only out of reset, at 0x29 until moved.
struct FakeSensor {
  int xshut;
  uint8_t addr = 0x29;
  bool alive = true;
  int mm = 8190;
  uint8_t regs[256] = {0};
};
static FakeSensor fake[3] = {{A1}, {A2}, {A3}};

static bool awake(const FakeSensor& s) { return s.alive && pin_mode[s.xshut] != OUTPUT; }
static void reset_check() {
  for (auto& s : fake)
    if (!awake(s)) s.addr = 0x29;
}
static FakeSensor* at(uint8_t addr) {
  reset_check();
  FakeSensor* found = nullptr;
  int count = 0;
  for (auto& s : fake)
    if (awake(s) && s.addr == addr) found = &s, count++;
  if (count > 1) {
    printf("FAIL: %d sensors answer at 0x%02x\n", count, addr);
    exit(1);
  }
  return found;
}

static uint8_t tx_addr, tx_buf[32], tx_len, rx_buf[32], rx_len, rx_pos;
// A stuck bus: each transfer waits out the board's I2C timeout (CONFIG_I2C_STM32_TRANSFER_TIMEOUT_MSEC), then fails.
static bool bus_stuck = false;
static const uint64_t I2C_TIMEOUT_US = 500000;
void TwoWire::begin() {}
void TwoWire::setClock(uint32_t) {}
void TwoWire::beginTransmission(uint8_t addr) { tx_addr = addr, tx_len = 0; }
size_t TwoWire::write(uint8_t b) { tx_buf[tx_len++] = b; return 1; }
static uint8_t last_reg;
uint8_t TwoWire::endTransmission() {
  if (bus_stuck) {
    advance(I2C_TIMEOUT_US);
    return 4;
  }
  FakeSensor* s = at(tx_addr);
  if (!s) return 2;  // NACK
  last_reg = tx_buf[0];
  for (int i = 1; i < tx_len; i++) {
    uint8_t reg = tx_buf[0] + i - 1, value = tx_buf[i];
    if (reg == 0x8A) {
      s->addr = value;
      continue;
    }
    s->regs[reg] = value;
  }
  return 0;
}
size_t TwoWire::requestFrom(uint8_t addr, size_t n) {
  if (bus_stuck) {
    advance(I2C_TIMEOUT_US);
    return 0;
  }
  FakeSensor* s = at(addr);
  if (!s) return 0;
  for (size_t i = 0; i < n; i++) {
    uint8_t reg = last_reg + i;
    uint8_t v = s->regs[reg];
    if (reg == 0xC0) v = 0xEE;
    if (reg == 0x83) v = 0x01;
    if (reg == 0x92) v = 0x86;  // 6 SPADs, aperture
    if (reg == 0x13) v = 0x07;  // a reading is ready
    if (reg == 0x1E) v = (uint8_t)(s->mm >> 8);
    if (reg == 0x1F) v = (uint8_t)(s->mm & 0xFF);
    rx_buf[i] = v;
  }
  rx_len = n, rx_pos = 0;
  return n;
}
int TwoWire::read() { return rx_pos < rx_len ? rx_buf[rx_pos++] : -1; }
TwoWire Wire;

#include "sketch.ino"

static int failures = 0;
static void check(bool ok, const char* what, const std::string& detail = "") {
  printf("%s %s %s\n", ok ? "ok  " : "FAIL", what, detail.c_str());
  if (!ok) failures++;
}
static void run_ms(int ms) {
  uint64_t until = clock_us + (uint64_t)ms * 1000;
  while (clock_us < until) loop();
}
static bool has(const String& s, const char* part) { return s.text.find(part) != std::string::npos; }
static bool wheels_forward(int speed) {
  return pin_pwm[ROVER_PIN_PWMA] == speed && pin_level[ROVER_PIN_AIN1] && !pin_level[ROVER_PIN_AIN2] &&
         pin_pwm[ROVER_PIN_PWMB] == speed && pin_level[ROVER_PIN_BIN1] && !pin_level[ROVER_PIN_BIN2];
}
static bool braked() {
  return pin_pwm[ROVER_PIN_PWMA] == 0 && pin_level[ROVER_PIN_AIN1] && pin_level[ROVER_PIN_AIN2] && pin_pwm[ROVER_PIN_PWMB] == 0 &&
         pin_level[ROVER_PIN_BIN1] && pin_level[ROVER_PIN_BIN2];
}

int main() {
  fake[0].mm = 400, fake[1].mm = 300, fake[2].mm = 8190;
  setup();
  check(fake[0].addr == 0x30 && fake[1].addr == 0x31 && fake[2].addr == 0x32, "the sensors moved to 0x30, 0x31 and 0x32");
  check(pin_level[ROVER_PIN_STBY] == HIGH && braked(), "the driver is out of standby, braked");
  run_ms(100);
  String r = rpc_ranges();
  check(r.text == "{\"front\":400,\"left\":300,\"right\":8190}", "ranges", r.text);
  String s = rpc_status();
  check(has(s, "\"sensors\":{\"front\":true,\"left\":true,\"right\":true}"), "status sees three sensors", s.text);

  String d = rpc_drive(200, 200, 1000);
  check(d.text == "{\"ok\":true,\"left\":200,\"right\":200,\"ms\":1000}", "a forward drive starts", d.text);
  run_ms(50);
  check(wheels_forward(200), "both wheels forward at 200");
  fake[0].mm = 120;
  uint64_t seen_at = clock_us;
  while (!braked() && clock_us - seen_at < 200000) loop();
  check(braked() && clock_us - seen_at < 40000, "the safety stop brakes within 40 ms", std::to_string((clock_us - seen_at) / 1000) + " ms");
  s = rpc_status();
  check(has(s, "something is 120 mm ahead, closer than the 150 mm stop distance"), "and says why", s.text);
  d = rpc_drive(200, 200, 500);
  check(has(d, "\"ok\":false") && has(d, "120 mm ahead"), "a forward drive is refused while blocked", d.text);
  d = rpc_drive(-150, -150, 300);
  check(has(d, "\"ok\":true"), "backing up is allowed", d.text);
  run_ms(250);
  check(pin_pwm[ROVER_PIN_PWMA] == 150 && !pin_level[ROVER_PIN_AIN1] && pin_level[ROVER_PIN_AIN2], "the wheels go back");
  run_ms(80);
  check(braked() && has(rpc_status(), "the drive's 300 ms were up"), "the drive ends by itself on time", rpc_status().text);
  check(!has(rpc_status(), "held up") && pin_level[ROVER_PIN_STBY], "and loop() ended it, not the guard timer", rpc_status().text);
  d = rpc_drive(150, -150, 9000);
  check(d.text == "{\"ok\":true,\"left\":150,\"right\":-150,\"ms\":3000}", "a turn on the spot, capped at 3000 ms", d.text);
  run_ms(2990);
  check(!braked(), "still turning at 2990 ms");
  run_ms(30);
  check(braked(), "stopped by 3020 ms");
  d = rpc_drive(999, 300, 100);
  check(has(d, "\"ok\":false"), "speeds are clamped first, and a clamped forward drive is still refused", d.text);
  fake[0].mm = 600;
  run_ms(50);
  rpc_drive(100, 100, 2000);
  run_ms(50);
  rpc_stop();
  run_ms(5);
  check(braked() && has(rpc_status(), "stop was called"), "stop brakes at once", rpc_status().text);

  // A stuck bus holds each Wire call for 500 ms, so loop() can't stop anything for 1.5 s. The guard timer puts the driver
  // in standby while it's held up: a forward drive once its front reading is stale, any drive once its time is up.
  rpc_drive(200, 200, 3000);
  run_ms(50);
  check(wheels_forward(200), "a forward drive before the bus sticks");
  uint32_t last_read = sensors[FRONT].read_at;
  uint64_t stuck_at = clock_us;
  bus_stuck = true;
  while (pin_low_at[ROVER_PIN_STBY] < stuck_at && clock_us - stuck_at < 3000000) loop();
  uint64_t cut_at = pin_low_at[ROVER_PIN_STBY];
  check(cut_at >= stuck_at && cut_at - stuck_at < I2C_TIMEOUT_US && cut_at / 1000 - last_read <= RANGE_FRESH_MS + GUARD_GRACE_MS + GUARD_PERIOD_MS,
        "with the bus stuck, the guard cuts a forward drive before the first Wire call gives up",
        cut_at >= stuck_at ? std::to_string(cut_at / 1000 - last_read) + " ms after the last front reading" : "never cut");
  check(braked() && pin_level[ROVER_PIN_STBY] && has(rpc_status(), "the front reading went stale while the microcontroller was held up"),
        "and loop() brakes and says why once it gets going", rpc_status().text);
  bus_stuck = false;
  run_ms(100);
  rpc_drive(150, -150, 300);
  run_ms(5);
  uint32_t until = drive_until;
  stuck_at = clock_us;
  bus_stuck = true;
  while (pin_low_at[ROVER_PIN_STBY] < stuck_at && clock_us - stuck_at < 3000000) loop();
  cut_at = pin_low_at[ROVER_PIN_STBY];
  check(cut_at >= stuck_at && cut_at / 1000 >= until + GUARD_GRACE_MS && cut_at / 1000 <= until + GUARD_GRACE_MS + GUARD_PERIOD_MS,
        "a turn held up by the stuck bus still ends within 30 ms of its time",
        cut_at >= stuck_at ? std::to_string(cut_at / 1000 - until) + " ms late" : "never cut");
  check(braked() && has(rpc_status(), "the drive's 300 ms were up while the microcontroller was held up"), "and says so", rpc_status().text);
  bus_stuck = false;
  run_ms(100);
  check(has(rpc_status(), "\"sensors\":{\"front\":true,\"left\":true,\"right\":true}") && has(rpc_drive(100, 100, 100), "\"ok\":true"),
        "once the bus lets go the sensors read again and the rover drives", rpc_status().text);
  run_ms(150);

  fake[0].alive = false;
  run_ms(100);
  s = rpc_status();
  check(has(s, "\"front\":false"), "a front sensor that stops answering is gone", s.text);
  check(has(rpc_ranges(), "\"front\":-1"), "and reads -1", rpc_ranges().text);
  d = rpc_drive(100, 100, 500);
  check(has(d, "isn't answering"), "forward is refused without it", d.text);
  check(pin_mode[A1] == OUTPUT && pin_level[A1] == LOW, "it is held in reset");
  fake[0].alive = true;
  run_ms(5100);
  check(has(rpc_status(), "\"front\":true") && fake[0].addr == 0x30, "and comes back at 0x30 once it answers", rpc_status().text);

  ticks_left = 0;
  rpc_drive(-100, 0, 200);
  run_ms(20);
  on_tick_left();
  on_tick_left();
  check(rpc_ticks().text == "{\"left\":-2,\"right\":0}", "ticks count down going back", rpc_ticks().text);

  run_ms(2000);
  pulses.clear();
  String l = rpc_look(120, 80);
  check(l.text == "{\"ok\":true,\"pan\":90,\"tilt\":45}", "look holds to the mount", l.text);
  run_ms(200);
  int pan = 0, tilt = 0;
  uint64_t pan_us = 0, tilt_us = 0;
  for (auto& p : pulses) {
    if (p.first == ROVER_PIN_SERVO_PAN) pan++, pan_us = p.second;
    if (p.first == ROVER_PIN_SERVO_TILT) tilt++, tilt_us = p.second;
  }
  check(pan >= 9 && pan <= 11 && tilt == pan, "about one pulse each every 20 ms", std::to_string(pan) + " pan, " + std::to_string(tilt) + " tilt in 200 ms");
  check(pan_us >= 2500 && pan_us < 2520, "pan 90 is a 2500 us pulse", std::to_string(pan_us));
  check(tilt_us >= 2000 && tilt_us < 2020, "tilt 45 is a 2000 us pulse", std::to_string(tilt_us));
  run_ms(1400);
  pulses.clear();
  run_ms(500);
  check(pulses.empty(), "the servos rest after 1.5 s");
  printf("%s\n", failures ? "SOME FAILED" : "ALL PASSED");
  return failures ? 1 : 0;
}
