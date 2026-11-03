// Muse Rover's pins and limits. setup-rover.sh writes this from ~/.muse-device/rover.json (rover_config.py), so
// change that file and run the setup again rather than editing this one.
#pragma once

#define ROVER_PIN_PWMA 5  // D5
#define ROVER_PIN_AIN1 4  // D4
#define ROVER_PIN_AIN2 8  // D8
#define ROVER_PIN_PWMB 6  // D6
#define ROVER_PIN_BIN1 12  // D12
#define ROVER_PIN_BIN2 13  // D13
#define ROVER_PIN_STBY A0
#define ROVER_PIN_ENC_LEFT 2  // D2
#define ROVER_PIN_ENC_RIGHT 3  // D3
#define ROVER_PIN_SERVO_PAN 9  // D9
#define ROVER_PIN_SERVO_TILT 10  // D10
#define ROVER_PIN_XSHUT_FRONT A1
#define ROVER_PIN_XSHUT_LEFT A2
#define ROVER_PIN_XSHUT_RIGHT A3

#define ROVER_STOP_MM 150
#define ROVER_MAX_DRIVE_MS 3000
#define ROVER_NEED_FRONT 1
#define ROVER_LEFT_INVERT 0
#define ROVER_RIGHT_INVERT 0
#define ROVER_PAN_INVERT 0
#define ROVER_TILT_INVERT 0
#define ROVER_PAN_MIN_DEG (-90)
#define ROVER_PAN_MAX_DEG (90)
#define ROVER_TILT_MIN_DEG (-45)
#define ROVER_TILT_MAX_DEG (45)
#define ROVER_SERVO_MIN_US 500
#define ROVER_SERVO_MAX_US 2500
#define ROVER_SERVO_HOLD_MS 1500
