// Host stand-ins for the parts of the Arduino API sketch.ino uses, shaped like ArduinoCore-API, for sketch_sim.cpp.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string>
typedef uint8_t pin_size_t;
typedef enum { LOW = 0, HIGH = 1, CHANGE = 2, FALLING = 3, RISING = 4 } PinStatus;
typedef enum { INPUT = 0x0, OUTPUT = 0x1, INPUT_PULLUP = 0x2, INPUT_PULLDOWN = 0x3 } PinMode;
enum { A0 = 14, A1, A2, A3, A4, A5 };
typedef void (*voidFuncPtr)(void);
void pinMode(pin_size_t, PinMode);
void digitalWrite(pin_size_t, PinStatus);
void analogWrite(pin_size_t, int);
unsigned long millis(void);
unsigned long micros(void);
void delay(unsigned long);
void attachInterrupt(pin_size_t, voidFuncPtr, PinStatus);
#define digitalPinToInterrupt(p) (p)
template <class T, class L, class H>
auto constrain(const T& amt, const L& low, const H& high) -> decltype((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt))) {
  return (amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt));
}
class String {
 public:
  String(const char*);
  std::string text;
};
