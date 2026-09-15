#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <chrono>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using namespace std::chrono_literals;

namespace {

struct Options {
  fs::path statusPath;
  fs::path controlPath;
  fs::path gamePath;
  DWORD parentPid = 0;
  bool altEnterEnabled = false;
  int cursorScalePercent = 100;
  std::wstring cursorWheelModifier = L"disabled";
  bool restoreOnly = false;
  DWORD restoreCursorBaseSize = 0;
};

Options parseOptions(int count, wchar_t** values) {
  Options options;
  for (int index = 1; index < count; ++index) {
    const std::wstring argument = values[index];
    const auto separator = argument.find(L'=');
    if (separator == std::wstring::npos || !argument.starts_with(L"--")) continue;
    const auto name = argument.substr(2, separator - 2);
    const auto value = argument.substr(separator + 1);
    if (name == L"status-path") options.statusPath = value;
    else if (name == L"control-path") options.controlPath = value;
    else if (name == L"game-path") options.gamePath = value;
    else if (name == L"parent-pid") {
      options.parentPid = static_cast<DWORD>(std::stoul(value));
    }
    else if (name == L"alt-enter-enabled") {
      options.altEnterEnabled = value == L"1";
    }
    else if (name == L"cursor-scale-percent") {
      options.cursorScalePercent = std::stoi(value);
    }
    else if (name == L"cursor-wheel-modifier") {
      options.cursorWheelModifier = value;
      std::transform(
        options.cursorWheelModifier.begin(),
        options.cursorWheelModifier.end(),
        options.cursorWheelModifier.begin(),
        towlower
      );
    }
    else if (name == L"restore-only") {
      options.restoreOnly = value == L"1";
    }
    else if (name == L"restore-cursor-base-size") {
      options.restoreCursorBaseSize = static_cast<DWORD>(std::stoul(value));
    }
  }
  const bool validCursorScale =
    options.cursorScalePercent >= 75
    && options.cursorScalePercent <= 800
    && options.cursorScalePercent % 25 == 0;
  if (!validCursorScale) {
    throw std::runtime_error("마우스 커서 크기 설정이 올바르지 않습니다");
  }
  if (
    options.cursorWheelModifier != L"disabled"
    && options.cursorWheelModifier != L"control"
    && options.cursorWheelModifier != L"alt"
  ) {
    throw std::runtime_error("마우스 휠 조절 설정이 올바르지 않습니다");
  }
  if (options.restoreOnly) return options;
  if (
    options.statusPath.empty()
    || options.controlPath.empty()
    || options.gamePath.empty()
    || options.parentPid == 0
  ) {
    throw std::runtime_error("필수 실행 인자가 없습니다");
  }
  return options;
}

std::wstring lowerPath(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), towlower);
  return value;
}

std::wstring processImagePath(DWORD pid) {
  const HANDLE process = OpenProcess(
    PROCESS_QUERY_LIMITED_INFORMATION,
    FALSE,
    pid
  );
  if (!process) return {};
  std::wstring path(32768, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  const bool succeeded = QueryFullProcessImageNameW(
    process,
    0,
    path.data(),
    &size
  );
  CloseHandle(process);
  if (!succeeded) return {};
  path.resize(size);
  return path;
}

std::wstring processImageName(DWORD pid) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return {};
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  std::wstring name;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == pid) {
        name = entry.szExeFile;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return name;
}

bool isTargetGameForeground(const fs::path& gamePath) {
  const HWND foreground = GetForegroundWindow();
  if (!foreground) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(foreground, &pid);
  const auto foregroundPath = processImagePath(pid);
  if (foregroundPath.empty()) {
    return lowerPath(processImageName(pid))
      == lowerPath(gamePath.filename().wstring());
  }
  return lowerPath(foregroundPath) == lowerPath(gamePath.wstring());
}

bool processRunning(HANDLE process) {
  return process && WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
}

DWORD readCursorBaseSize() {
  DWORD value = 0;
  DWORD size = sizeof(value);
  const LSTATUS result = RegGetValueW(
    HKEY_CURRENT_USER,
    L"Control Panel\\Cursors",
    L"CursorBaseSize",
    RRF_RT_REG_DWORD,
    nullptr,
    &value,
    &size
  );
  if (result == ERROR_FILE_NOT_FOUND) {
    return static_cast<DWORD>(std::max(1, GetSystemMetrics(SM_CXCURSOR)));
  }
  if (result != ERROR_SUCCESS || value == 0) {
    throw std::runtime_error("Windows 마우스 커서 크기를 확인하지 못했습니다");
  }
  return value;
}

void setCursorBaseSize(DWORD value) {
  if (value == 0 || value > 256) {
    throw std::runtime_error("Windows 마우스 커서 크기 값이 올바르지 않습니다");
  }
  constexpr UINT setCursorBaseSizeAction = 0x2029;
  if (!SystemParametersInfoW(
    setCursorBaseSizeAction,
    0,
    reinterpret_cast<PVOID>(static_cast<ULONG_PTR>(value)),
    SPIF_UPDATEINIFILE
  )) {
    throw std::runtime_error("Windows 마우스 커서 크기를 적용하지 못했습니다");
  }
  if (readCursorBaseSize() != value) {
    throw std::runtime_error("Windows 마우스 커서 크기 적용을 확인하지 못했습니다");
  }
}

class ForegroundGameCache {
public:
  explicit ForegroundGameCache(fs::path gamePath)
    : gamePath_(lowerPath(gamePath.wstring())),
      gameFileName_(lowerPath(gamePath.filename().wstring())) {}

  bool matches() {
    const HWND foreground = GetForegroundWindow();
    DWORD pid = 0;
    if (foreground) GetWindowThreadProcessId(foreground, &pid);
    changed_ = foreground != lastWindow_ || pid != lastPid_;
    if (!changed_) return lastMatch_;
    lastWindow_ = foreground;
    lastPid_ = pid;
    const auto foregroundPath = processImagePath(pid);
    if (foregroundPath.empty()) {
      lastProcessName_ = processImageName(pid);
      lastMatch_ = lowerPath(lastProcessName_) == gameFileName_;
      return lastMatch_;
    }
    const fs::path foregroundFile(foregroundPath);
    lastProcessName_ = foregroundFile.filename().wstring();
    lastMatch_ =
      lowerPath(foregroundPath) == gamePath_
      || lowerPath(lastProcessName_) == gameFileName_;
    return lastMatch_;
  }

  bool changed() const {
    return changed_;
  }

  DWORD pid() const {
    return lastPid_;
  }

  const std::wstring& processName() const {
    return lastProcessName_;
  }

private:
  std::wstring gamePath_;
  std::wstring gameFileName_;
  HWND lastWindow_ = nullptr;
  DWORD lastPid_ = 0;
  std::wstring lastProcessName_;
  bool lastMatch_ = false;
  bool changed_ = false;
};

class CursorScaleGuard {
public:
  CursorScaleGuard(fs::path gamePath, int scalePercent)
    : foregroundGame_(std::move(gamePath)),
      scalePercent_(scalePercent) {
    originalBaseSize_ = readCursorBaseSize();
  }

  ~CursorScaleGuard() {
    if (!active_) return;
    try {
      setCursorBaseSize(originalBaseSize_);
    } catch (...) {
    }
  }

  bool update() {
    const bool gameForeground = foregroundGame_.matches();
    const bool foregroundChanged = foregroundGame_.changed();
    const bool shouldBeActive = scalePercent_ != 100 && gameForeground;
    if (scaleChanged_) {
      scaleChanged_ = false;
      if (shouldBeActive) apply();
      else if (active_) restore();
      return true;
    }
    if (shouldBeActive == active_) return foregroundChanged;
    if (shouldBeActive) apply();
    else restore();
    return true;
  }

  void restore() {
    if (!active_) return;
    setCursorBaseSize(originalBaseSize_);
    active_ = false;
  }

  bool active() const {
    return active_;
  }

  DWORD originalBaseSize() const {
    return originalBaseSize_;
  }

  DWORD foregroundPid() const {
    return foregroundGame_.pid();
  }

  const std::wstring& foregroundProcessName() const {
    return foregroundGame_.processName();
  }

  bool adjustScale(int direction) {
    if (direction == 0) return false;
    const int nextScalePercent = std::clamp(
      scalePercent_ + (direction > 0 ? 25 : -25),
      75,
      800
    );
    if (nextScalePercent == scalePercent_) return false;
    scalePercent_ = nextScalePercent;
    scaleChanged_ = true;
    return true;
  }

  int scalePercent() const {
    return scalePercent_;
  }

private:
  void apply() {
    const DWORD scaledBaseSize = static_cast<DWORD>(std::clamp(
      MulDiv(static_cast<int>(originalBaseSize_), scalePercent_, 100),
      1,
      256
    ));
    try {
      setCursorBaseSize(scaledBaseSize);
      active_ = true;
    } catch (...) {
      try {
        setCursorBaseSize(originalBaseSize_);
      } catch (...) {
      }
      throw;
    }
  }

  ForegroundGameCache foregroundGame_;
  int scalePercent_ = 100;
  DWORD originalBaseSize_ = 32;
  bool active_ = false;
  bool scaleChanged_ = false;
};

class CursorWheelGuard {
public:
  CursorWheelGuard(
    fs::path gamePath,
    std::wstring modifier,
    CursorScaleGuard& cursorScaleGuard
  )
    : gamePath_(std::move(gamePath)),
      modifier_(std::move(modifier)),
      cursorScaleGuard_(cursorScaleGuard) {
    active_ = this;
    hook_ = SetWindowsHookExW(
      WH_MOUSE_LL,
      mouseHook,
      GetModuleHandleW(nullptr),
      0
    );
    if (!hook_) {
      active_ = nullptr;
      throw std::runtime_error("마우스 휠 입력 감시를 시작하지 못했습니다");
    }
  }

  ~CursorWheelGuard() {
    if (hook_) UnhookWindowsHookEx(hook_);
    active_ = nullptr;
  }

private:
  static LRESULT CALLBACK mouseHook(
    int code,
    WPARAM message,
    LPARAM parameter
  ) {
    if (code != HC_ACTION || !active_ || message != WM_MOUSEWHEEL) {
      return CallNextHookEx(nullptr, code, message, parameter);
    }
    const auto* event = reinterpret_cast<const MSLLHOOKSTRUCT*>(parameter);
    if (!event || (event->flags & LLMHF_INJECTED) != 0) {
      return CallNextHookEx(nullptr, code, message, parameter);
    }
    const bool modifierPressed = active_->modifier_ == L"control"
      ? (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0
      : (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
    if (
      !modifierPressed
      || !isTargetGameForeground(active_->gamePath_)
    ) {
      return CallNextHookEx(nullptr, code, message, parameter);
    }
    const int wheelDelta = static_cast<SHORT>(HIWORD(event->mouseData));
    active_->cursorScaleGuard_.adjustScale(wheelDelta);
    return 1;
  }

  inline static CursorWheelGuard* active_ = nullptr;
  fs::path gamePath_;
  std::wstring modifier_;
  CursorScaleGuard& cursorScaleGuard_;
  HHOOK hook_ = nullptr;
};

bool stopRequested(const fs::path& controlPath) {
  std::ifstream input(controlPath);
  if (!input) return false;
  std::stringstream contents;
  contents << input.rdbuf();
  input.close();
  std::error_code error;
  fs::remove(controlPath, error);
  const auto value = contents.str();
  return value.find("\"command\":\"stop\"") != std::string::npos
    || value.find("\"command\": \"stop\"") != std::string::npos;
}

std::string jsonAscii(const std::wstring& value) {
  std::string result;
  result.reserve(value.size());
  for (const wchar_t character : value) {
    if (character == L'\\' || character == L'"') result.push_back('\\');
    result.push_back(character >= 32 && character <= 126
      ? static_cast<char>(character)
      : '?');
  }
  return result;
}

void writeStatus(
  const fs::path& statusPath,
  bool running,
  DWORD pid,
  bool cursorActive = false,
  int cursorScalePercent = 100,
  DWORD originalCursorBaseSize = 0,
  DWORD foregroundPid = 0,
  const std::wstring& foregroundProcessName = {},
  const std::string& error = {}
) {
  fs::create_directories(statusPath.parent_path());
  auto partialPath = statusPath;
  partialPath += L".tmp";
  std::ofstream output(partialPath, std::ios::trunc);
  output
    << "{\"running\":" << (running ? "true" : "false")
    << ",\"pid\":" << pid
    << ",\"cursorActive\":" << (cursorActive ? "true" : "false")
    << ",\"cursorScalePercent\":" << cursorScalePercent
    << ",\"originalCursorBaseSize\":" << originalCursorBaseSize
    << ",\"foregroundPid\":" << foregroundPid
    << ",\"foregroundProcessName\":\""
    << jsonAscii(foregroundProcessName)
    << "\""
    << ",\"error\":";
  if (error.empty()) output << "null";
  else output << "\"입력 기능 helper 오류\"";
  output
    << ",\"updatedAt\":"
    << std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()
    ).count()
    << "}";
  output.close();
  std::error_code fileError;
  fs::remove(statusPath, fileError);
  fileError.clear();
  fs::rename(partialPath, statusPath, fileError);
  if (fileError) {
    fs::copy_file(
      partialPath,
      statusPath,
      fs::copy_options::overwrite_existing,
      fileError
    );
    fs::remove(partialPath, fileError);
  }
}

class AltEnterGuard {
public:
  explicit AltEnterGuard(fs::path gamePath)
    : gamePath_(std::move(gamePath)) {
    active_ = this;
    hook_ = SetWindowsHookExW(
      WH_KEYBOARD_LL,
      keyboardHook,
      GetModuleHandleW(nullptr),
      0
    );
    if (!hook_) {
      active_ = nullptr;
      throw std::runtime_error("키보드 입력 감시를 시작하지 못했습니다");
    }
  }

  ~AltEnterGuard() {
    if (hook_) UnhookWindowsHookEx(hook_);
    active_ = nullptr;
  }

private:
  static LRESULT CALLBACK keyboardHook(
    int code,
    WPARAM message,
    LPARAM parameter
  ) {
    if (code != HC_ACTION || !active_) {
      return CallNextHookEx(nullptr, code, message, parameter);
    }
    const auto* event =
      reinterpret_cast<const KBDLLHOOKSTRUCT*>(parameter);
    if (!event) {
      return CallNextHookEx(nullptr, code, message, parameter);
    }
    const bool keyDown =
      message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    const bool keyUp =
      message == WM_KEYUP || message == WM_SYSKEYUP;
    if (event->vkCode == VK_RETURN) {
      const bool altPressed =
        (event->flags & LLKHF_ALTDOWN) != 0
        || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
      if (
        keyDown
        && altPressed
        && isTargetGameForeground(active_->gamePath_)
      ) {
        active_->blockingEnter_ = true;
        return 1;
      }
      if (keyUp && active_->blockingEnter_) {
        active_->blockingEnter_ = false;
        return 1;
      }
    }
    return CallNextHookEx(nullptr, code, message, parameter);
  }

  inline static AltEnterGuard* active_ = nullptr;
  fs::path gamePath_;
  HHOOK hook_ = nullptr;
  bool blockingEnter_ = false;
};

}

int wmain(int count, wchar_t** values) {
  HANDLE mutex = CreateMutexW(
    nullptr,
    TRUE,
    L"Local\\NogiremInputGuardHelper"
  );
  if (!mutex || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (mutex) CloseHandle(mutex);
    return 2;
  }
  HANDLE parent = nullptr;
  Options options;
  try {
    options = parseOptions(count, values);
    if (options.restoreCursorBaseSize > 0) {
      setCursorBaseSize(options.restoreCursorBaseSize);
    }
    if (options.restoreOnly) {
      ReleaseMutex(mutex);
      CloseHandle(mutex);
      return 0;
    }
    parent = OpenProcess(SYNCHRONIZE, FALSE, options.parentPid);
    if (!parent) throw std::runtime_error("부모 프로세스를 확인하지 못했습니다");
    std::error_code error;
    fs::remove(options.controlPath, error);
    std::unique_ptr<AltEnterGuard> altEnterGuard;
    if (options.altEnterEnabled) {
      altEnterGuard = std::make_unique<AltEnterGuard>(options.gamePath);
    }
    CursorScaleGuard cursorScaleGuard(
      options.gamePath,
      options.cursorScalePercent
    );
    std::unique_ptr<CursorWheelGuard> cursorWheelGuard;
    if (options.cursorWheelModifier != L"disabled") {
      cursorWheelGuard = std::make_unique<CursorWheelGuard>(
        options.gamePath,
        options.cursorWheelModifier,
        cursorScaleGuard
      );
    }
    cursorScaleGuard.update();
    writeStatus(
      options.statusPath,
      true,
      GetCurrentProcessId(),
      cursorScaleGuard.active(),
      cursorScaleGuard.scalePercent(),
      cursorScaleGuard.originalBaseSize(),
      cursorScaleGuard.foregroundPid(),
      cursorScaleGuard.foregroundProcessName()
    );

    MSG message{};
    while (processRunning(parent) && !stopRequested(options.controlPath)) {
      while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_QUIT) break;
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      if (message.message == WM_QUIT) break;
      if (cursorScaleGuard.update()) {
        writeStatus(
          options.statusPath,
          true,
          GetCurrentProcessId(),
          cursorScaleGuard.active(),
          cursorScaleGuard.scalePercent(),
          cursorScaleGuard.originalBaseSize(),
          cursorScaleGuard.foregroundPid(),
          cursorScaleGuard.foregroundProcessName()
        );
      }
      Sleep(50);
    }
    cursorScaleGuard.restore();
    writeStatus(
      options.statusPath,
      false,
      GetCurrentProcessId(),
      false,
      cursorScaleGuard.scalePercent(),
      cursorScaleGuard.originalBaseSize()
    );
    CloseHandle(parent);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return 0;
  } catch (const std::exception& error) {
    if (!options.statusPath.empty()) {
      writeStatus(
        options.statusPath,
        false,
        GetCurrentProcessId(),
        false,
        options.cursorScalePercent,
        options.restoreCursorBaseSize,
        0,
        {},
        error.what()
      );
    }
    if (parent) CloseHandle(parent);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return 1;
  }
}
