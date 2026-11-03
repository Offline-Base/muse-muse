// Host stand-in for Arduino_RouterBridge, for sketch_sim.cpp, which calls the sketch's functions directly.
#pragma once
#include "Arduino.h"
class BridgeClass {
 public:
  bool begin();
  template <typename F>
  bool provide(const char*, F) { return true; }
};
extern BridgeClass Bridge;
