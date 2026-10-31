#include "fps_limiter.h"

#include <SDL.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include "perf_monitor.h"

namespace fallout {

FpsLimiter::FpsLimiter(unsigned int fps)
    : _fps(fps)
    , _ticks(0)
{
}

void FpsLimiter::mark()
{
    _ticks = SDL_GetTicks();
}

void FpsLimiter::throttle() const
{
    if (1000 / _fps > SDL_GetTicks() - _ticks) {
        unsigned int delay = 1000 / _fps - (SDL_GetTicks() - _ticks);
        perfMonitorSleep(delay);
        SDL_Delay(delay);
    }
#ifdef __EMSCRIPTEN__
    else {
        // An over-budget frame still has to yield so the browser can paint,
        // deliver touch events and run audio callbacks.
        emscripten_sleep(0);
    }
#endif
}

} // namespace fallout
