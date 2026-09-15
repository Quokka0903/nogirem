#include <windows.h>

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
    else if (name == L"restore-only") {
      options.restoreOnly = value == L"1";
    }
    else if (name == L"restore-cursor-base-size") {
      options.restoreCursorBaseSize = static_cast<DWORD>(std::stoul(value));
    }
  }
  const bool validCursorScale =
    options.cursorScalePercent == 75
    || options.cursorScalePercent == 100
    || options.cursorScalePercent == 125
    || options.cursorScalePercent == 150
    || options.cursorScalePercent == 200;
  if (!validCursorScale) {
    throw std::runtime_error("마우스 커서 크기 설정이 올바르지 않습니다");
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

bool isTargetGameForeground(const fs::path& gamePath) {
  const HWND foreground = GetForegroundWindow();
  if (!foreground) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(foreground, &pid);
  const auto foregroundPath = processImagePath(pid);
  if (foregroundPath.empty()) return false;
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

void restoreSystemCursors() {
  if (!SystemParametersInfoW(
    SPI_SETCURSORS,
    0,
    nullptr,
    SPIF_SENDCHANGE
  )) {
    throw std::runtime_error("Windows 마우스 커서를 복원하지 못했습니다");
  }
}

void setCursorBaseSize(DWORD value) {
  if (value == 0 || value > 512) {
    throw std::runtime_error("Windows 마우스 커서 크기 값이 올바르지 않습니다");
  }
  const LSTATUS result = RegSetKeyValueW(
    HKEY_CURRENT_USER,
    L"Control Panel\\Cursors",
    L"CursorBaseSize",
    REG_DWORD,
    &value,
    sizeof(value)
  );
  if (result != ERROR_SUCCESS) {
    throw std::runtime_error("Windows 마우스 커서 크기를 저장하지 못했습니다");
  }
  restoreSystemCursors();
}

class ForegroundGameCache {
public:
  explicit ForegroundGameCache(fs::path gamePath)
    : gamePath_(lowerPath(gamePath.wstring())) {}

  bool matches() {
    const HWND foreground = GetForegroundWindow();
    DWORD pid = 0;
    if (foreground) GetWindowThreadProcessId(foreground, &pid);
    if (foreground == lastWindow_ && pid == lastPid_) return lastMatch_;
    lastWindow_ = foreground;
    lastPid_ = pid;
    const auto foregroundPath = processImagePath(pid);
    lastMatch_ =
      !foregroundPath.empty() && lowerPath(foregroundPath) == gamePath_;
    return lastMatch_;
  }

private:
  std::wstring gamePath_;
  HWND lastWindow_ = nullptr;
  DWORD lastPid_ = 0;
  bool lastMatch_ = false;
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
    const bool shouldBeActive =
      scalePercent_ != 100 && foregroundGame_.matches();
    if (shouldBeActive == active_) return false;
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

private:
  void apply() {
    const DWORD scaledBaseSize = static_cast<DWORD>(std::max(
      1,
      MulDiv(static_cast<int>(originalBaseSize_), scalePercent_, 100)
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

void writeStatus(
  const fs::path& statusPath,
  bool running,
  DWORD pid,
  bool cursorActive = false,
  int cursorScalePercent = 100,
  DWORD originalCursorBaseSize = 0,
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
      if (options.restoreCursorBaseSize == 0) restoreSystemCursors();
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
    writeStatus(
      options.statusPath,
      true,
      GetCurrentProcessId(),
      false,
      options.cursorScalePercent,
      cursorScaleGuard.originalBaseSize()
    );

    const UINT_PTR healthTimer = SetTimer(nullptr, 0, 50, nullptr);
    if (!healthTimer) {
      throw std::runtime_error("입력 감시 상태 타이머를 시작하지 못했습니다");
    }
    MSG message{};
    while (processRunning(parent) && !stopRequested(options.controlPath)) {
      const BOOL messageResult = GetMessageW(&message, nullptr, 0, 0);
      if (messageResult <= 0) break;
      TranslateMessage(&message);
      DispatchMessageW(&message);
      if (cursorScaleGuard.update()) {
        writeStatus(
          options.statusPath,
          true,
          GetCurrentProcessId(),
          cursorScaleGuard.active(),
          options.cursorScalePercent,
          cursorScaleGuard.originalBaseSize()
        );
      }
    }
    KillTimer(nullptr, healthTimer);
    cursorScaleGuard.restore();
    writeStatus(
      options.statusPath,
      false,
      GetCurrentProcessId(),
      false,
      options.cursorScalePercent,
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
        error.what()
      );
    }
    if (parent) CloseHandle(parent);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return 1;
  }
}
