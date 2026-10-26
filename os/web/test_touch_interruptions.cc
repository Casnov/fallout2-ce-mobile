// Exercise the production recognizer and MUI event queue without game assets
// or a rendering device. Including the sources exposes the queue boundary:
// SDL can already have released capture while MUI still shows the Down frame.
#include <cassert>
#include <cstdio>
#include "../../src/touch.cc"
#include "../../src/mui.cc"

namespace fallout {
int screenGetWidth() { return 960; }
int screenGetHeight() { return 480; }
float hudGetPixelsPerDp() { return 1; }
void touchLogUiStaleDrop(int) {}
}
using namespace fallout;

static SDL_TouchFingerEvent finger(SDL_FingerID id, float x, float y)
{
    SDL_TouchFingerEvent event = {};
    event.fingerId = id;
    event.timestamp = SDL_GetTicks();
    event.x = x;
    event.y = y;
    return event;
}

int main()
{
    SDL_Init(SDL_INIT_TIMER);
    Gesture gesture;
    auto first = finger(1, 0.2f, 0.2f);
    touch_handle_start(&first);
    touch_handle_end(&first);
    touch_process_gesture();
    assert(touch_get_gesture(&gesture) && gesture.type == kTap);

    // A tap queued just before touchcancel must not survive cancellation.
    touch_handle_start(&first);
    touch_handle_end(&first);
    touch_process_gesture();
    touch_cancel_all();
    assert(!touch_get_gesture(&gesture));
    assert(!touch_any_finger_down());

    // Cancel a live pinch, then reuse SDL's finger ID for an ordinary tap.
    auto second = finger(2, 0.8f, 0.2f);
    touch_handle_start(&first);
    touch_handle_start(&second);
    second.x = 0.9f;
    touch_handle_move(&second);
    touch_process_gesture();
    assert(touch_get_gesture(&gesture) && gesture.type == kPan && gesture.numberOfTouches == 2);
    touch_cancel_all();
    assert(!touch_any_finger_down());
    assert(!touch_get_gesture(&gesture));
    touch_handle_start(&first);
    touch_handle_end(&first);
    touch_process_gesture();
    assert(touch_get_gesture(&gesture) && gesture.type == kTap && gesture.numberOfTouches == 1);

    const MuiRect button = {10,10,100,60};
    MuiContext ui;
    ui.isInteractive = true;
    ui.pixelsPerDp = 1;
    const auto down = [] {
        gEvents.push_back({PointerEventType::Down,30,30,SDL_GetTicks()});
        processEvents();
    };
    down();
    assert(!ui.touchable("button",button));
    gEvents.push_back({PointerEventType::Up,30,30,SDL_GetTicks()});
    processEvents();
    assert(ui.touchable("button",button)); // Control: the real widget accepts a normal tap.

    for (bool captured : {false,true}) {
        gPointer = Pointer();
        gActiveId.clear();
        down();
        bool pressed = false;
        assert(!ui.touchable("button",button,&pressed) && pressed);
        gFingerCaptured = captured;
        gSecondFinger.down = true;
        gEvents.push_back({PointerEventType::Up,30,30,SDL_GetTicks()});
        muiCancelTouches();
        processEvents();
        assert(!ui.touchable("button",button,&pressed) && !pressed);
        assert(!gPointer.down && !gFingerCaptured && !gSecondFinger.down);
        assert(gEvents.empty());
        gActiveId.clear(); // muiRender's usual end-of-frame cleanup.
    }
    SDL_Quit();
    std::puts("Touch interruptions: queued tap, pinch, reused IDs and MUI release passed");
}
