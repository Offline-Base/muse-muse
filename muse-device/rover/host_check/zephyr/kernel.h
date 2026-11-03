// Host stand-in for the little of Zephyr the sketch uses, for sketch_sim.cpp. One thread, so the lock does nothing, and a
// timer's ticks are milliseconds, whose expiry sketch_sim.cpp calls as its made-up clock passes them.
#pragma once
struct k_mutex { int x; };
typedef struct { long ticks; } k_timeout_t;
#define K_FOREVER ((k_timeout_t){-1})
#define K_MSEC(ms) ((k_timeout_t){(long)(ms)})
struct k_timer;
typedef void (*k_timer_expiry_t)(struct k_timer*);
typedef void (*k_timer_stop_t)(struct k_timer*);
struct k_timer {
  k_timer_expiry_t expiry;
  long period_ms;
  unsigned long long due_us;
};
int k_mutex_init(struct k_mutex*);
int k_mutex_lock(struct k_mutex*, k_timeout_t);
int k_mutex_unlock(struct k_mutex*);
void k_timer_init(struct k_timer*, k_timer_expiry_t, k_timer_stop_t);
void k_timer_start(struct k_timer*, k_timeout_t, k_timeout_t);
