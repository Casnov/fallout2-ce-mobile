#include "window.h"

#include <emscripten.h>

#include "../../svga.h"

namespace fallout {

void webExit(int status)
{
    // A final user checkpoint can resume main from a Promise. Emscripten's
    // timer callback boundary owns ExitStatus; a bare Promise continuation
    // would otherwise expose it as an unhandled rejection after onExit.
    emscripten_sleep(0);
    // The game's main has finished, including its own cleanup. Pending SDL/
    // Asyncify callbacks must not keep the runtime alive and defer atexit/onExit.
    emscripten_force_exit(status);
}

// Keep DOM details out of the shared screen and input implementations.
// clang-format off
EM_JS(void, webOpenGameFilesJs, (const char* mode), {
    Module['webOpenFiles']?.(mode ? UTF8ToString(mode) : "");
});
EM_ASYNC_JS(int, webExchangeSavesJs, (const char* mode), {
    try {
        if (!Module['webExchangeSaves']) throw new Error('Save exchange is unavailable');
        await Module['webExchangeSaves'](UTF8ToString(mode));
        return 1;
    } catch (error) {
        console.error('Save exchange could not start', error);
        return 0;
    }
});
EM_JS(void, webPerfMarkJs, (const char* name), {
    Module['webPerfMark']?.(UTF8ToString(name));
});

EM_JS(int, webViewportWidthJs, (), {
    return Math.max(1, Math.round(Module['canvas'].getBoundingClientRect().width || innerWidth));
});

EM_JS(int, webViewportHeightJs, (), {
    return Math.max(1, Math.round(Module['canvas'].getBoundingClientRect().height || innerHeight));
});

EM_JS(void, webConfigureViewportJs, (int width, int height), {
    Module['webViewport'].configure(width, height);
});

EM_JS(float, webScreenDensityJs, (), {
    const canvas = Module['canvas'];
    return canvas.width / canvas.getBoundingClientRect().width || 1;
});

EM_JS(int, webSafeInset, (int index), {
    const element = document.getElementById('safe-area');
    if (!element) return 0;
    const style = getComputedStyle(element);
    const property = ['paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom'][index];
    const canvas = Module['canvas'];
    const rect = canvas.getBoundingClientRect();
    const scale = index === 0 || index === 2 ? canvas.width / rect.width : canvas.height / rect.height;
    // Letterboxing outside the canvas already provides part of a safe inset.
    const bars = [rect.left, rect.top, innerWidth - rect.right, innerHeight - rect.bottom];
    return Math.round(Math.max(0, (parseFloat(style[property]) || 0) - Math.max(0, bars[index])) * scale);
});

EM_JS(bool, webMouseAsTouchJs, (), {
    return Module['webMouseAsTouch'] === true;
});
EM_JS(int, webPollWindowStateJs, (), {
    return Module['webWindow'] ? Module['webWindow'].poll() : 1;
});

EM_JS(void, webBeginTextInputJs, (), { Module['webTextInput'].begin(); });
EM_JS(void, webEndTextInputJs, (), { Module['webTextInput'].end(); });
EM_JS(bool, webTextInputDoneJs, (), { return Module['webTextInput'].done(); });

EM_JS(int, webTakeTextInputJs, (char32_t* buffer, int capacity), {
    const value = Module['webTextInput'].take();
    if (value === null) return -1;
    const count = Math.min(value.length, capacity);
    HEAPU32.set(value.slice(0, count), buffer >>> 2);
    return count;
});

EM_JS(void, webTextInputFieldJs, (const char32_t* value, int length, int screenWidth, int screenHeight, float x, float y, float width, float height, float fontSize, int maxLength), {
    Module['webTextInput'].update(Array.from(HEAPU32.subarray(value >>> 2, (value >>> 2) + length)),
        [screenWidth, screenHeight], [x, y, width, height], fontSize, maxLength);
});

EM_JS(void, webRendererInfoJs, (int ww, int wh, int ow, int oh, int lw, int lh), {
    Module['webRendererInfo'] = {window:[ww,wh], output:[ow,oh], logical:[lw,lh]};
});
// clang-format on

void webOpenGameFiles(const char* mode)
{
    webOpenGameFilesJs(mode);
}

bool webExchangeSaves(const char* mode)
{
    return webExchangeSavesJs(mode) != 0;
}

void webPerfMark(const char* name)
{
    webPerfMarkJs(name);
}

int webViewportWidth()
{
    return webViewportWidthJs();
}

int webViewportHeight()
{
    return webViewportHeightJs();
}

void webConfigureViewport(int width, int height)
{
    webConfigureViewportJs(width, height);
}

float webScreenDensity()
{
    return webScreenDensityJs();
}

bool webMouseAsTouch()
{
    return webMouseAsTouchJs();
}

int webPollWindowState() { return webPollWindowStateJs(); }

void webSafeInsets(int insets[4])
{
    for (int index = 0; index < 4; index++) {
        insets[index] = webSafeInset(index);
    }
}

bool webTakeTextInput(std::u32string& value)
{
    char32_t buffer[1024];
    int length = webTakeTextInputJs(buffer, 1024);
    if (length < 0) return false;
    value.assign(buffer, length);
    return true;
}

void webBeginTextInput() { webBeginTextInputJs(); }
void webEndTextInput() { webEndTextInputJs(); }
bool webTextInputDone() { return webTextInputDoneJs(); }

void webTextInputField(const std::u32string& value, float x, float y, float width, float height, float fontSize, int maxLength)
{
    // MUI draws in renderer output pixels, independently of the world's
    // logical resolution and letterboxing.
    int outputWidth, outputHeight;
    if (SDL_GetRendererOutputSize(gSdlRenderer, &outputWidth, &outputHeight) == 0) {
        webTextInputFieldJs(value.data(), value.size(), outputWidth, outputHeight, x, y, width, height, fontSize, maxLength);
    }
}

void webUpdateRendererInfo()
{
    static Uint32 previous = 0;
    Uint32 now = SDL_GetTicks();
    if (now - previous < 1000) return;
    previous = now;
    int ww, wh, ow, oh, lw, lh;
    SDL_GetWindowSize(gSdlWindow, &ww, &wh);
    SDL_GetRendererOutputSize(gSdlRenderer, &ow, &oh);
    SDL_RenderGetLogicalSize(gSdlRenderer, &lw, &lh);
    webRendererInfoJs(ww, wh, ow, oh, lw, lh);
}

} // namespace fallout
