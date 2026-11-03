// Host stand-in for the core's Wire, for sketch_sim.cpp. Its functions are defined there, on a made-up bus.
#pragma once
#include "Arduino.h"
class TwoWire {
 public:
  void begin();
  void setClock(uint32_t);
  void beginTransmission(uint8_t);
  size_t write(uint8_t);
  uint8_t endTransmission();
  size_t requestFrom(uint8_t, size_t);
  int read();
};
extern TwoWire Wire;
