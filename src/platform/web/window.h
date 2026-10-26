#ifndef FALLOUT_PLATFORM_WEB_WINDOW_H_
#define FALLOUT_PLATFORM_WEB_WINDOW_H_

#include <string>

namespace fallout {

int webViewportWidth();
int webViewportHeight();
void webConfigureViewport(int width, int height);
float webScreenDensity();
void webSafeInsets(int insets[4]);
bool webMouseAsTouch();
void webBeginTextInput();
void webEndTextInput();
bool webTakeTextInput(std::u32string& value);
bool webTextInputDone();
void webTextInputField(const std::u32string& value, float x, float y, float width, float height, float fontSize, int maxLength);
void webUpdateRendererInfo();
void webExit(int status);
void webOpenGameFiles(const char* mode);
bool webExchangeSaves(const char* mode);
// browser.js createGameWindow.poll contract; consumed only on the native stack.
enum WebWindowState {
    kWebWindowActive = 1,
    kWebCancelTouches = 2,
    kWebViewportChanged = 4,
    kWebWindowInterrupted = 8,
};
int webPollWindowState();

} // namespace fallout

#endif
