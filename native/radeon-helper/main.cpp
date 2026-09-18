#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <windows.h>
#include "ADLXHelper.h"
#include "I3DSettings.h"
#include "ISystem.h"

using namespace adlx;

namespace fs = std::filesystem;

struct GoalState
{
    std::string key;
    std::string label;
    bool supported = false;
    bool met = false;
    std::string currentValue = "지원 안 함";
};

template <typename T>
void releaseInterface(T*& value)
{
    if (value != nullptr)
    {
        value->Release();
        value = nullptr;
    }
}

std::string escapeJson(const std::string& value)
{
    std::ostringstream output;
    for (const unsigned char character : value)
    {
        switch (character)
        {
        case '"': output << "\\\""; break;
        case '\\': output << "\\\\"; break;
        case '\b': output << "\\b"; break;
        case '\f': output << "\\f"; break;
        case '\n': output << "\\n"; break;
        case '\r': output << "\\r"; break;
        case '\t': output << "\\t"; break;
        default:
            if (character < 0x20)
            {
                const char* hex = "0123456789abcdef";
                output << "\\u00" << hex[(character >> 4) & 0x0f] << hex[character & 0x0f];
            }
            else
            {
                output << character;
            }
        }
    }
    return output.str();
}

void mergeGoal(GoalState& aggregate, bool supported, bool met, const std::string& currentValue)
{
    if (!supported) return;
    if (!aggregate.supported)
    {
        aggregate.supported = true;
        aggregate.met = true;
        aggregate.currentValue = currentValue;
    }
    aggregate.met = aggregate.met && met;
    if (aggregate.currentValue != currentValue) aggregate.currentValue = "GPU별 설정 다름";
}

std::string booleanText(bool enabled)
{
    return enabled ? "켜기" : "끄기";
}

bool readBooleanSetting(
    IADLX3DSettingsServices* settings,
    IADLXGPU* gpu,
    const std::string& key,
    bool apply,
    bool target,
    bool& supported,
    bool& enabled,
    std::string& error)
{
    ADLX_RESULT result = ADLX_FAIL;
    adlx_bool isSupported = false;
    adlx_bool isEnabled = false;

    if (key == "antiLag")
    {
        IADLX3DAntiLag* setting = nullptr;
        result = settings->GetAntiLag(gpu, &setting);
        if (ADLX_SUCCEEDED(result) && setting != nullptr)
        {
            result = setting->IsSupported(&isSupported);
            if (ADLX_SUCCEEDED(result) && isSupported && apply) result = setting->SetEnabled(target);
            if (ADLX_SUCCEEDED(result) && isSupported) result = setting->IsEnabled(&isEnabled);
            releaseInterface(setting);
        }
    }
    else if (key == "chill")
    {
        IADLX3DChill* setting = nullptr;
        result = settings->GetChill(gpu, &setting);
        if (ADLX_SUCCEEDED(result) && setting != nullptr)
        {
            result = setting->IsSupported(&isSupported);
            if (ADLX_SUCCEEDED(result) && isSupported && apply) result = setting->SetEnabled(target);
            if (ADLX_SUCCEEDED(result) && isSupported) result = setting->IsEnabled(&isEnabled);
            releaseInterface(setting);
        }
    }
    else
    {
        IADLX3DEnhancedSync* setting = nullptr;
        result = settings->GetEnhancedSync(gpu, &setting);
        if (ADLX_SUCCEEDED(result) && setting != nullptr)
        {
            result = setting->IsSupported(&isSupported);
            if (ADLX_SUCCEEDED(result) && isSupported && apply) result = setting->SetEnabled(target);
            if (ADLX_SUCCEEDED(result) && isSupported) result = setting->IsEnabled(&isEnabled);
            releaseInterface(setting);
        }
    }

    if (!ADLX_SUCCEEDED(result))
    {
        error = key + " 설정 처리 실패: ADLX " + std::to_string(result);
        return false;
    }
    supported = isSupported;
    enabled = isEnabled;
    return true;
}

bool readVerticalSync(
    IADLX3DSettingsServices* settings,
    IADLXGPU* gpu,
    bool apply,
    bool& supported,
    ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE& mode,
    std::string& error)
{
    IADLX3DWaitForVerticalRefresh* setting = nullptr;
    ADLX_RESULT result = settings->GetWaitForVerticalRefresh(gpu, &setting);
    adlx_bool isSupported = false;
    if (ADLX_SUCCEEDED(result) && setting != nullptr)
    {
        result = setting->IsSupported(&isSupported);
        if (ADLX_SUCCEEDED(result) && isSupported && apply) result = setting->SetMode(WFVR_ALWAYS_OFF);
        if (ADLX_SUCCEEDED(result) && isSupported) result = setting->GetMode(&mode);
        releaseInterface(setting);
    }
    if (!ADLX_SUCCEEDED(result))
    {
        error = "수직 동기화 설정 처리 실패: ADLX " + std::to_string(result);
        return false;
    }
    supported = isSupported;
    return true;
}

std::string verticalSyncText(ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE mode)
{
    switch (mode)
    {
    case WFVR_ALWAYS_OFF: return "항상 끄기";
    case WFVR_OFF_UNLESS_APP_SPECIFIES: return "응용 프로그램 지정 시 켜기";
    case WFVR_ON_UNLESS_APP_SPECIFIES: return "응용 프로그램 지정 시 끄기";
    case WFVR_ALWAYS_ON: return "항상 켜기";
    default: return "알 수 없음";
    }
}

void printResult(
    bool detected,
    const std::vector<std::string>& gpuNames,
    const std::vector<GoalState>& goals,
    const std::string& reason)
{
    bool allMet = detected;
    bool hasSupportedGoal = false;
    for (const GoalState& goal : goals)
    {
        if (!goal.supported) continue;
        hasSupportedGoal = true;
        allMet = allMet && goal.met;
    }
    allMet = allMet && hasSupportedGoal;

    std::ostringstream output;
    output << "{\"detected\":" << (detected ? "true" : "false") << ",\"gpus\":[";
    for (size_t index = 0; index < gpuNames.size(); ++index)
    {
        if (index > 0) output << ",";
        output << "{\"name\":\"" << escapeJson(gpuNames[index]) << "\"}";
    }
    output << "],\"goals\":[";
    for (size_t index = 0; index < goals.size(); ++index)
    {
        if (index > 0) output << ",";
        const GoalState& goal = goals[index];
        output
            << "{\"key\":\"" << goal.key
            << "\",\"label\":\"" << escapeJson(goal.label)
            << "\",\"supported\":" << (goal.supported ? "true" : "false")
            << ",\"met\":" << (goal.met ? "true" : "false")
            << ",\"currentValue\":\"" << escapeJson(goal.currentValue) << "\"}";
    }
    output << "],\"allMet\":" << (allMet ? "true" : "false");
    if (reason.empty()) output << ",\"reason\":null";
    else output << ",\"reason\":\"" << escapeJson(reason) << "\"";
    output << "}";
    std::cout << output.str() << std::endl;
}

int runOneShot(bool apply, bool legacyDriver)
{
    std::vector<GoalState> goals = {
        {"verticalSyncOff", "수직 동기화 항상 끄기"},
        {"enhancedSyncOff", "Enhanced Sync 끄기"},
        {"antiLagOn", "Radeon Anti-Lag 켜기"},
        {"chillOff", "Radeon Chill 끄기"},
    };
    std::vector<std::string> gpuNames;
    std::string error;

    ADLX_RESULT result = legacyDriver
        ? g_ADLX.InitializeWithIncompatibleDriver()
        : g_ADLX.Initialize();
    if (!legacyDriver && !ADLX_SUCCEEDED(result))
    {
        g_ADLX.Terminate();
        result = g_ADLX.InitializeWithIncompatibleDriver();
    }
    if (!ADLX_SUCCEEDED(result))
    {
        printResult(false, gpuNames, goals, "AMD ADLX 초기화 실패: " + std::to_string(result));
        return 0;
    }

    IADLXSystem* system = g_ADLX.GetSystemServices();
    IADLXGPUList* gpus = nullptr;
    IADLX3DSettingsServices* settings = nullptr;
    result = system == nullptr ? ADLX_FAIL : system->GetGPUs(&gpus);
    if (ADLX_SUCCEEDED(result)) result = system->Get3DSettingsServices(&settings);
    if (!ADLX_SUCCEEDED(result) || gpus == nullptr || settings == nullptr)
    {
        releaseInterface(settings);
        releaseInterface(gpus);
        g_ADLX.Terminate();
        printResult(false, gpuNames, goals, "AMD GPU 설정 서비스를 찾지 못했습니다");
        return 0;
    }

    for (adlx_uint index = 0; index < gpus->Size(); ++index)
    {
        IADLXGPU* gpu = nullptr;
        if (!ADLX_SUCCEEDED(gpus->At(index, &gpu)) || gpu == nullptr) continue;
        const char* name = nullptr;
        if (ADLX_SUCCEEDED(gpu->Name(&name)) && name != nullptr) gpuNames.emplace_back(name);
        else gpuNames.emplace_back("AMD Radeon GPU");

        bool supported = false;
        bool enabled = false;
        ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE mode = WFVR_ALWAYS_ON;
        std::string settingError;

        if (readBooleanSetting(settings, gpu, "chill", apply, false, supported, enabled, settingError))
            mergeGoal(goals[3], supported, !enabled, booleanText(enabled));
        else if (error.empty()) error = settingError;

        if (readBooleanSetting(settings, gpu, "enhancedSync", apply, false, supported, enabled, settingError))
            mergeGoal(goals[1], supported, !enabled, booleanText(enabled));
        else if (error.empty()) error = settingError;

        if (readVerticalSync(settings, gpu, apply, supported, mode, settingError))
            mergeGoal(goals[0], supported, mode == WFVR_ALWAYS_OFF, verticalSyncText(mode));
        else if (error.empty()) error = settingError;

        if (readBooleanSetting(settings, gpu, "antiLag", apply, true, supported, enabled, settingError))
            mergeGoal(goals[2], supported, enabled, booleanText(enabled));
        else if (error.empty()) error = settingError;

        releaseInterface(gpu);
    }

    releaseInterface(settings);
    releaseInterface(gpus);
    g_ADLX.Terminate();
    printResult(!gpuNames.empty(), gpuNames, goals, error);
    return 0;
}

// ---------------------------------------------------------------------------
// 데몬 모드
//
// 터보 키(native/turbo-key)와 입력 기능 helper(native/input-guard-helper)가
// 쓰는 상태/제어 JSON 규약을 그대로 따른다.
//   - 단일 실행 뮤텍스
//   - 부모 프로세스 감시(OpenProcess(SYNCHRONIZE) + WaitForSingleObject)
//   - 임시 파일 + rename 으로 상태 파일 원자적 교체
//   - {"command":"..."} 제어 파일을 읽고 소비
// ---------------------------------------------------------------------------

const DWORD daemonTickIntervalMs = 250;
const ULONGLONG daemonRefreshIntervalMs = 2000;

struct DaemonOptions
{
    std::wstring statusPath;
    std::wstring controlPath;
    DWORD parentPid = 0;
    bool legacyDriver = false;
};

struct AntiLagState
{
    bool supported = false;
    bool enabled = false;
    bool levelSupported = false;
    ADLX_ANTILAG_STATE level = ANTILAG;
};

struct FrameRateTargetState
{
    bool supported = false;
    bool enabled = false;
    adlx_int fps = 0;
    bool rangeKnown = false;
    adlx_int minFps = 0;
    adlx_int maxFps = 0;
};

struct GpuSettings
{
    bool verticalSyncSupported = false;
    ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE verticalSyncMode = WFVR_ALWAYS_ON;
    bool enhancedSyncSupported = false;
    bool enhancedSyncEnabled = false;
    bool chillSupported = false;
    bool chillEnabled = false;
    AntiLagState antiLag;
    FrameRateTargetState frameRateTarget;
};

struct GpuSnapshot
{
    adlx_uint listIndex = 0;
    adlx_int uniqueId = -1;
    std::string name = "AMD Radeon GPU";
    GpuSettings settings;
};

struct MergedBool
{
    bool supported = false;
    bool value = false;
    bool mixed = false;

    void merge(bool isSupported, bool nextValue)
    {
        if (!isSupported) return;
        if (!supported)
        {
            supported = true;
            value = nextValue;
            return;
        }
        if (value != nextValue) mixed = true;
    }
};

struct MergedInt
{
    bool supported = false;
    adlx_int value = 0;
    bool mixed = false;

    void merge(bool isSupported, adlx_int nextValue)
    {
        if (!isSupported) return;
        if (!supported)
        {
            supported = true;
            value = nextValue;
            return;
        }
        if (value != nextValue) mixed = true;
    }
};

struct MergedText
{
    bool supported = false;
    std::string value;
    bool mixed = false;

    void merge(bool isSupported, const std::string& nextValue)
    {
        if (!isSupported) return;
        if (!supported)
        {
            supported = true;
            value = nextValue;
            return;
        }
        if (value != nextValue) mixed = true;
    }
};

struct MergedSettings
{
    MergedText verticalSync;
    MergedBool enhancedSync;
    MergedBool chill;
    MergedBool antiLag;
    MergedText antiLagLevel;
    MergedBool frameRateTarget;
    MergedInt frameRateTargetFps;
    bool frameRateTargetRangeKnown = false;
    adlx_int frameRateTargetMinFps = 0;
    adlx_int frameRateTargetMaxFps = 0;
};

struct DaemonState
{
    bool running = false;
    bool detected = false;
    bool legacyDriver = false;
    std::vector<GpuSnapshot> gpus;
    MergedSettings merged;
    bool hasReceipt = false;
    bool receiptApplied = false;
    long long receiptCapturedAt = 0;
    std::vector<GpuSnapshot> receipt;
    std::vector<std::string> warnings;
    std::string lastCommand;
    std::string lastResult;
    std::string error;
};

const char* boolText(bool value)
{
    return value ? "true" : "false";
}

std::string antiLagLevelKey(ADLX_ANTILAG_STATE level)
{
    return level == ANTILAGNEXT ? "antiLagNext" : "antiLag";
}

std::string verticalSyncKey(ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE mode)
{
    switch (mode)
    {
    case WFVR_ALWAYS_OFF: return "alwaysOff";
    case WFVR_OFF_UNLESS_APP_SPECIFIES: return "offUnlessAppSpecifies";
    case WFVR_ON_UNLESS_APP_SPECIFIES: return "onUnlessAppSpecifies";
    case WFVR_ALWAYS_ON: return "alwaysOn";
    default: return "unknown";
    }
}

std::string quotedText(const std::string& value)
{
    return "\"" + escapeJson(value) + "\"";
}

long long currentTimeMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

bool processRunning(HANDLE process)
{
    return process != nullptr && WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
}

fs::path receiptPathFor(const fs::path& statusPath)
{
    const fs::path directory = statusPath.parent_path();
    if (directory.empty()) return fs::path(L"radeon-receipt.json");
    return directory / L"radeon-receipt.json";
}

bool writeFileAtomic(const fs::path& path, const std::string& contents)
{
    std::error_code error;
    if (!path.parent_path().empty()) fs::create_directories(path.parent_path(), error);

    fs::path partialPath = path;
    partialPath += L".tmp";
    {
        std::ofstream output(partialPath, std::ios::binary | std::ios::trunc);
        if (!output) return false;
        output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
        output.close();
        if (!output) return false;
    }

    error.clear();
    fs::remove(path, error);
    error.clear();
    fs::rename(partialPath, path, error);
    if (!error) return true;

    error.clear();
    fs::copy_file(partialPath, path, fs::copy_options::overwrite_existing, error);
    std::error_code removeError;
    fs::remove(partialPath, removeError);
    return !error;
}

// 제어 파일은 turbo-key/input-guard-helper와 같은 방식으로 문자열 검사만 한다.
// 외부 JSON 파서 의존성을 늘리지 않기 위한 선택이며, 명령 이름만 인식한다.
std::string takeControlCommand(const fs::path& controlPath)
{
    std::ifstream input(controlPath, std::ios::binary);
    if (!input) return std::string();
    std::ostringstream contents;
    contents << input.rdbuf();
    input.close();
    std::error_code error;
    fs::remove(controlPath, error);

    const std::string value = contents.str();
    const char* const commands[] = {"stop", "probe", "apply", "restore"};
    for (const char* command : commands)
    {
        const std::string quoted = std::string("\"") + command + "\"";
        if (value.find("\"command\":" + quoted) != std::string::npos
            || value.find("\"command\": " + quoted) != std::string::npos)
        {
            return std::string(command);
        }
    }
    return std::string();
}

void probeVerticalSync(IADLX3DSettingsServices* services, IADLXGPU* gpu, GpuSettings& target)
{
    IADLX3DWaitForVerticalRefresh* setting = nullptr;
    if (ADLX_SUCCEEDED(services->GetWaitForVerticalRefresh(gpu, &setting)) && setting != nullptr)
    {
        adlx_bool supported = false;
        if (ADLX_SUCCEEDED(setting->IsSupported(&supported)) && supported)
        {
            ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE mode = WFVR_ALWAYS_ON;
            if (ADLX_SUCCEEDED(setting->GetMode(&mode)))
            {
                target.verticalSyncSupported = true;
                target.verticalSyncMode = mode;
            }
        }
    }
    releaseInterface(setting);
}

void probeEnhancedSync(IADLX3DSettingsServices* services, IADLXGPU* gpu, GpuSettings& target)
{
    IADLX3DEnhancedSync* setting = nullptr;
    if (ADLX_SUCCEEDED(services->GetEnhancedSync(gpu, &setting)) && setting != nullptr)
    {
        adlx_bool supported = false;
        if (ADLX_SUCCEEDED(setting->IsSupported(&supported)) && supported)
        {
            adlx_bool enabled = false;
            if (ADLX_SUCCEEDED(setting->IsEnabled(&enabled)))
            {
                target.enhancedSyncSupported = true;
                target.enhancedSyncEnabled = enabled;
            }
        }
    }
    releaseInterface(setting);
}

void probeChill(IADLX3DSettingsServices* services, IADLXGPU* gpu, GpuSettings& target)
{
    IADLX3DChill* setting = nullptr;
    if (ADLX_SUCCEEDED(services->GetChill(gpu, &setting)) && setting != nullptr)
    {
        adlx_bool supported = false;
        if (ADLX_SUCCEEDED(setting->IsSupported(&supported)) && supported)
        {
            adlx_bool enabled = false;
            if (ADLX_SUCCEEDED(setting->IsEnabled(&enabled)))
            {
                target.chillSupported = true;
                target.chillEnabled = enabled;
            }
        }
    }
    releaseInterface(setting);
}

void probeAntiLag(IADLX3DSettingsServices* services, IADLXGPU* gpu, GpuSettings& target)
{
    IADLX3DAntiLag* setting = nullptr;
    if (ADLX_SUCCEEDED(services->GetAntiLag(gpu, &setting)) && setting != nullptr)
    {
        adlx_bool supported = false;
        if (ADLX_SUCCEEDED(setting->IsSupported(&supported)) && supported)
        {
            adlx_bool enabled = false;
            if (ADLX_SUCCEEDED(setting->IsEnabled(&enabled)))
            {
                target.antiLag.supported = true;
                target.antiLag.enabled = enabled;
            }

            // 구형 드라이버에는 IADLX3DAntiLag1이 없다. QueryInterface 실패는
            // 반드시 "레벨 미지원"으로 낮춰 처리하고 절대 크래시하지 않는다.
            IADLX3DAntiLag1* levelSetting = nullptr;
            if (target.antiLag.supported
                && ADLX_SUCCEEDED(setting->QueryInterface(
                    IADLX3DAntiLag1::IID(),
                    reinterpret_cast<void**>(&levelSetting)))
                && levelSetting != nullptr)
            {
                ADLX_ANTILAG_STATE level = ANTILAG;
                if (ADLX_SUCCEEDED(levelSetting->GetLevel(&level)))
                {
                    target.antiLag.levelSupported = true;
                    target.antiLag.level = level;
                }
            }
            releaseInterface(levelSetting);
        }
    }
    releaseInterface(setting);
}

void probeFrameRateTarget(IADLX3DSettingsServices* services, IADLXGPU* gpu, GpuSettings& target)
{
    IADLX3DFrameRateTargetControl* setting = nullptr;
    if (ADLX_SUCCEEDED(services->GetFrameRateTargetControl(gpu, &setting)) && setting != nullptr)
    {
        adlx_bool supported = false;
        if (ADLX_SUCCEEDED(setting->IsSupported(&supported)) && supported)
        {
            target.frameRateTarget.supported = true;
            adlx_bool enabled = false;
            if (ADLX_SUCCEEDED(setting->IsEnabled(&enabled))) target.frameRateTarget.enabled = enabled;
            adlx_int fps = 0;
            if (ADLX_SUCCEEDED(setting->GetFPS(&fps))) target.frameRateTarget.fps = fps;
            ADLX_IntRange range = {};
            if (ADLX_SUCCEEDED(setting->GetFPSRange(&range)))
            {
                target.frameRateTarget.rangeKnown = true;
                target.frameRateTarget.minFps = range.minValue;
                target.frameRateTarget.maxFps = range.maxValue;
            }
        }
    }
    releaseInterface(setting);
}

// 안전 규칙(변경 금지): ADLX_ANTILAG_STATE에는 ANTILAG과 ANTILAGNEXT가 있다.
// Anti-Lag Next는 게임 클라이언트에 직접 개입하는 방식이라 안티치트 오탐 이력이
// 있고, 마비노기에는 안티치트가 붙어 있다. 그래서 이 helper는
//   1) Anti-Lag을 켤 때 반드시 SetLevel(ANTILAG)을 명시적으로 호출하고
//   2) ANTILAGNEXT를 설정하는 코드 경로를 어디에도 두지 않으며
//   3) 현재 레벨이 ANTILAGNEXT이면 적용 자체를 거부한다.
// 이 함수가 유일한 SetLevel 호출 지점이며 값은 ANTILAG으로 고정되어 있다.
bool setAntiLagLevelToAntiLag(IADLX3DAntiLag* antiLag)
{
    IADLX3DAntiLag1* levelSetting = nullptr;
    bool applied = false;
    if (ADLX_SUCCEEDED(antiLag->QueryInterface(
            IADLX3DAntiLag1::IID(),
            reinterpret_cast<void**>(&levelSetting)))
        && levelSetting != nullptr)
    {
        applied = ADLX_SUCCEEDED(levelSetting->SetLevel(ANTILAG));
    }
    releaseInterface(levelSetting);
    return applied;
}

void probeGpuSettings(IADLX3DSettingsServices* services, IADLXGPU* gpu, GpuSettings& target)
{
    probeVerticalSync(services, gpu, target);
    probeEnhancedSync(services, gpu, target);
    probeChill(services, gpu, target);
    probeAntiLag(services, gpu, target);
    probeFrameRateTarget(services, gpu, target);
}

void applyGpuSettings(
    IADLX3DSettingsServices* services,
    IADLXGPU* gpu,
    const GpuSettings& before,
    std::string& error)
{
    if (before.chillSupported)
    {
        IADLX3DChill* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetChill(gpu, &setting)) && setting != nullptr)
        {
            if (!ADLX_SUCCEEDED(setting->SetEnabled(false)) && error.empty())
                error = "Radeon Chill 끄기를 적용하지 못했습니다";
        }
        else if (error.empty()) error = "Radeon Chill 설정을 열지 못했습니다";
        releaseInterface(setting);
    }

    if (before.enhancedSyncSupported)
    {
        IADLX3DEnhancedSync* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetEnhancedSync(gpu, &setting)) && setting != nullptr)
        {
            if (!ADLX_SUCCEEDED(setting->SetEnabled(false)) && error.empty())
                error = "Enhanced Sync 끄기를 적용하지 못했습니다";
        }
        else if (error.empty()) error = "Enhanced Sync 설정을 열지 못했습니다";
        releaseInterface(setting);
    }

    if (before.verticalSyncSupported)
    {
        IADLX3DWaitForVerticalRefresh* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetWaitForVerticalRefresh(gpu, &setting)) && setting != nullptr)
        {
            if (!ADLX_SUCCEEDED(setting->SetMode(WFVR_ALWAYS_OFF)) && error.empty())
                error = "수직 동기화 끄기를 적용하지 못했습니다";
        }
        else if (error.empty()) error = "수직 동기화 설정을 열지 못했습니다";
        releaseInterface(setting);
    }

    if (before.antiLag.supported)
    {
        IADLX3DAntiLag* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetAntiLag(gpu, &setting)) && setting != nullptr)
        {
            // 레벨을 먼저 ANTILAG으로 고정한 뒤에 켠다. 순서를 바꾸면 드라이버
            // 기본값이 Anti-Lag Next인 환경에서 잠깐이라도 Next가 켜질 수 있다.
            if (before.antiLag.levelSupported
                && !setAntiLagLevelToAntiLag(setting)
                && error.empty())
            {
                error = "Radeon Anti-Lag 레벨을 고정하지 못했습니다";
            }
            if (!ADLX_SUCCEEDED(setting->SetEnabled(true)) && error.empty())
                error = "Radeon Anti-Lag 켜기를 적용하지 못했습니다";
        }
        else if (error.empty()) error = "Radeon Anti-Lag 설정을 열지 못했습니다";
        releaseInterface(setting);
    }
}

void restoreGpuSettings(
    IADLX3DSettingsServices* services,
    IADLXGPU* gpu,
    const GpuSettings& before,
    std::string& error)
{
    if (before.chillSupported)
    {
        IADLX3DChill* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetChill(gpu, &setting)) && setting != nullptr)
        {
            if (!ADLX_SUCCEEDED(setting->SetEnabled(before.chillEnabled)) && error.empty())
                error = "Radeon Chill 설정을 되돌리지 못했습니다";
        }
        else if (error.empty()) error = "Radeon Chill 설정을 열지 못했습니다";
        releaseInterface(setting);
    }

    if (before.enhancedSyncSupported)
    {
        IADLX3DEnhancedSync* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetEnhancedSync(gpu, &setting)) && setting != nullptr)
        {
            if (!ADLX_SUCCEEDED(setting->SetEnabled(before.enhancedSyncEnabled)) && error.empty())
                error = "Enhanced Sync 설정을 되돌리지 못했습니다";
        }
        else if (error.empty()) error = "Enhanced Sync 설정을 열지 못했습니다";
        releaseInterface(setting);
    }

    if (before.verticalSyncSupported)
    {
        IADLX3DWaitForVerticalRefresh* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetWaitForVerticalRefresh(gpu, &setting)) && setting != nullptr)
        {
            if (!ADLX_SUCCEEDED(setting->SetMode(before.verticalSyncMode)) && error.empty())
                error = "수직 동기화 설정을 되돌리지 못했습니다";
        }
        else if (error.empty()) error = "수직 동기화 설정을 열지 못했습니다";
        releaseInterface(setting);
    }

    if (before.antiLag.supported)
    {
        IADLX3DAntiLag* setting = nullptr;
        if (ADLX_SUCCEEDED(services->GetAntiLag(gpu, &setting)) && setting != nullptr)
        {
            // 영수증에는 ANTILAGNEXT가 저장될 수 없다(그 경우 적용 자체를 거부한다).
            // 그래도 방어적으로 ANTILAG일 때만 레벨을 되돌린다.
            if (before.antiLag.levelSupported
                && before.antiLag.level == ANTILAG
                && !setAntiLagLevelToAntiLag(setting)
                && error.empty())
            {
                error = "Radeon Anti-Lag 레벨을 되돌리지 못했습니다";
            }
            if (!ADLX_SUCCEEDED(setting->SetEnabled(before.antiLag.enabled)) && error.empty())
                error = "Radeon Anti-Lag 설정을 되돌리지 못했습니다";
        }
        else if (error.empty()) error = "Radeon Anti-Lag 설정을 열지 못했습니다";
        releaseInterface(setting);
    }
}

std::string buildSettingsJson(const GpuSettings& settings)
{
    std::ostringstream output;
    output
        << "{\"verticalSync\":{\"supported\":" << boolText(settings.verticalSyncSupported)
        << ",\"mode\":"
        << (settings.verticalSyncSupported
            ? quotedText(verticalSyncKey(settings.verticalSyncMode))
            : std::string("null"))
        << "},\"enhancedSync\":{\"supported\":" << boolText(settings.enhancedSyncSupported)
        << ",\"enabled\":" << boolText(settings.enhancedSyncEnabled)
        << "},\"chill\":{\"supported\":" << boolText(settings.chillSupported)
        << ",\"enabled\":" << boolText(settings.chillEnabled)
        << "},\"antiLag\":{\"supported\":" << boolText(settings.antiLag.supported)
        << ",\"enabled\":" << boolText(settings.antiLag.enabled)
        << ",\"levelSupported\":" << boolText(settings.antiLag.levelSupported)
        << ",\"level\":"
        << (settings.antiLag.levelSupported
            ? quotedText(antiLagLevelKey(settings.antiLag.level))
            : std::string("null"))
        << "},\"frameRateTarget\":{\"supported\":" << boolText(settings.frameRateTarget.supported)
        << ",\"enabled\":" << boolText(settings.frameRateTarget.enabled)
        << ",\"fps\":" << settings.frameRateTarget.fps
        << ",\"minFps\":"
        << (settings.frameRateTarget.rangeKnown
            ? std::to_string(static_cast<int>(settings.frameRateTarget.minFps))
            : std::string("null"))
        << ",\"maxFps\":"
        << (settings.frameRateTarget.rangeKnown
            ? std::to_string(static_cast<int>(settings.frameRateTarget.maxFps))
            : std::string("null"))
        << "}}";
    return output.str();
}

std::string buildReceiptJson(const DaemonState& state)
{
    std::ostringstream output;
    output
        << "{\"version\":1,\"capturedAt\":" << state.receiptCapturedAt
        << ",\"applied\":" << boolText(state.receiptApplied)
        << ",\"gpus\":[";
    for (size_t index = 0; index < state.receipt.size(); ++index)
    {
        if (index > 0) output << ",";
        const GpuSnapshot& snapshot = state.receipt[index];
        output
            << "{\"index\":" << static_cast<unsigned int>(snapshot.listIndex)
            << ",\"name\":" << quotedText(snapshot.name)
            << ",\"uniqueId\":" << static_cast<int>(snapshot.uniqueId)
            << ",\"before\":" << buildSettingsJson(snapshot.settings)
            << "}";
    }
    output << "]}";
    return output.str();
}

std::string buildCapabilitiesJson(const MergedSettings& merged)
{
    std::ostringstream output;
    output
        << "{\"verticalSync\":{\"supported\":" << boolText(merged.verticalSync.supported)
        << "},\"enhancedSync\":{\"supported\":" << boolText(merged.enhancedSync.supported)
        << "},\"chill\":{\"supported\":" << boolText(merged.chill.supported)
        << "},\"antiLag\":{\"supported\":" << boolText(merged.antiLag.supported)
        << ",\"levelSupported\":" << boolText(merged.antiLagLevel.supported)
        << ",\"level\":"
        << (merged.antiLagLevel.supported && !merged.antiLagLevel.mixed
            ? quotedText(merged.antiLagLevel.value)
            : std::string("null"))
        << "},\"frameRateTarget\":{\"supported\":" << boolText(merged.frameRateTarget.supported)
        << ",\"minFps\":"
        << (merged.frameRateTargetRangeKnown
            ? std::to_string(static_cast<int>(merged.frameRateTargetMinFps))
            : std::string("null"))
        << ",\"maxFps\":"
        << (merged.frameRateTargetRangeKnown
            ? std::to_string(static_cast<int>(merged.frameRateTargetMaxFps))
            : std::string("null"))
        << "}}";
    return output.str();
}

std::string buildMergedSettingsJson(const MergedSettings& merged)
{
    std::ostringstream output;
    output
        << "{\"verticalSync\":{\"supported\":" << boolText(merged.verticalSync.supported)
        << ",\"mode\":"
        << (merged.verticalSync.supported && !merged.verticalSync.mixed
            ? quotedText(merged.verticalSync.value)
            : std::string("null"))
        << ",\"mixed\":" << boolText(merged.verticalSync.mixed)
        << "},\"enhancedSync\":{\"supported\":" << boolText(merged.enhancedSync.supported)
        << ",\"enabled\":" << boolText(merged.enhancedSync.value)
        << ",\"mixed\":" << boolText(merged.enhancedSync.mixed)
        << "},\"chill\":{\"supported\":" << boolText(merged.chill.supported)
        << ",\"enabled\":" << boolText(merged.chill.value)
        << ",\"mixed\":" << boolText(merged.chill.mixed)
        << "},\"antiLag\":{\"supported\":" << boolText(merged.antiLag.supported)
        << ",\"enabled\":" << boolText(merged.antiLag.value)
        << ",\"levelSupported\":" << boolText(merged.antiLagLevel.supported)
        << ",\"level\":"
        << (merged.antiLagLevel.supported && !merged.antiLagLevel.mixed
            ? quotedText(merged.antiLagLevel.value)
            : std::string("null"))
        << ",\"mixed\":" << boolText(merged.antiLag.mixed || merged.antiLagLevel.mixed)
        << "},\"frameRateTarget\":{\"supported\":" << boolText(merged.frameRateTarget.supported)
        << ",\"enabled\":" << boolText(merged.frameRateTarget.value)
        << ",\"fps\":" << static_cast<int>(merged.frameRateTargetFps.value)
        << ",\"mixed\":" << boolText(merged.frameRateTarget.mixed || merged.frameRateTargetFps.mixed)
        << "}}";
    return output.str();
}

std::string buildStatusJson(const DaemonState& state)
{
    std::ostringstream output;
    output
        << "{\"running\":" << boolText(state.running)
        << ",\"pid\":" << static_cast<unsigned long>(GetCurrentProcessId())
        << ",\"mode\":\"daemon\""
        << ",\"legacyDriver\":" << boolText(state.legacyDriver)
        << ",\"detected\":" << boolText(state.detected)
        << ",\"gpus\":[";
    for (size_t index = 0; index < state.gpus.size(); ++index)
    {
        if (index > 0) output << ",";
        const GpuSnapshot& snapshot = state.gpus[index];
        output
            << "{\"index\":" << static_cast<unsigned int>(snapshot.listIndex)
            << ",\"name\":" << quotedText(snapshot.name)
            << ",\"uniqueId\":" << static_cast<int>(snapshot.uniqueId)
            << "}";
    }
    output
        << "],\"capabilities\":" << buildCapabilitiesJson(state.merged)
        << ",\"settings\":" << buildMergedSettingsJson(state.merged)
        << ",\"receipt\":" << (state.hasReceipt ? buildReceiptJson(state) : std::string("null"))
        << ",\"warnings\":[";
    for (size_t index = 0; index < state.warnings.size(); ++index)
    {
        if (index > 0) output << ",";
        output << quotedText(state.warnings[index]);
    }
    output
        << "],\"lastCommand\":"
        << (state.lastCommand.empty() ? std::string("null") : quotedText(state.lastCommand))
        << ",\"lastResult\":"
        << (state.lastResult.empty() ? std::string("null") : quotedText(state.lastResult))
        << ",\"error\":"
        << (state.error.empty() ? std::string("null") : quotedText(state.error))
        << ",\"updatedAt\":" << currentTimeMs()
        << "}";
    return output.str();
}

void refreshSnapshot(
    DaemonState& state,
    IADLXGPUList* gpus,
    IADLX3DSettingsServices* services)
{
    state.gpus.clear();
    state.warnings.clear();
    state.merged = MergedSettings();

    bool antiLagNextDetected = false;
    for (adlx_uint index = 0; index < gpus->Size(); ++index)
    {
        IADLXGPU* gpu = nullptr;
        if (!ADLX_SUCCEEDED(gpus->At(index, &gpu)) || gpu == nullptr) continue;

        GpuSnapshot snapshot;
        snapshot.listIndex = index;
        const char* name = nullptr;
        if (ADLX_SUCCEEDED(gpu->Name(&name)) && name != nullptr) snapshot.name = name;
        adlx_int uniqueId = -1;
        if (ADLX_SUCCEEDED(gpu->UniqueId(&uniqueId))) snapshot.uniqueId = uniqueId;
        probeGpuSettings(services, gpu, snapshot.settings);
        releaseInterface(gpu);

        const GpuSettings& settings = snapshot.settings;
        state.merged.verticalSync.merge(
            settings.verticalSyncSupported,
            verticalSyncKey(settings.verticalSyncMode));
        state.merged.enhancedSync.merge(settings.enhancedSyncSupported, settings.enhancedSyncEnabled);
        state.merged.chill.merge(settings.chillSupported, settings.chillEnabled);
        state.merged.antiLag.merge(settings.antiLag.supported, settings.antiLag.enabled);
        state.merged.antiLagLevel.merge(
            settings.antiLag.levelSupported,
            antiLagLevelKey(settings.antiLag.level));
        state.merged.frameRateTarget.merge(
            settings.frameRateTarget.supported,
            settings.frameRateTarget.enabled);
        state.merged.frameRateTargetFps.merge(
            settings.frameRateTarget.supported,
            settings.frameRateTarget.fps);
        if (settings.frameRateTarget.rangeKnown)
        {
            if (!state.merged.frameRateTargetRangeKnown)
            {
                state.merged.frameRateTargetRangeKnown = true;
                state.merged.frameRateTargetMinFps = settings.frameRateTarget.minFps;
                state.merged.frameRateTargetMaxFps = settings.frameRateTarget.maxFps;
            }
            else
            {
                // 여러 GPU가 있으면 모두가 받아들이는 교집합을 남긴다.
                if (settings.frameRateTarget.minFps > state.merged.frameRateTargetMinFps)
                    state.merged.frameRateTargetMinFps = settings.frameRateTarget.minFps;
                if (settings.frameRateTarget.maxFps < state.merged.frameRateTargetMaxFps)
                    state.merged.frameRateTargetMaxFps = settings.frameRateTarget.maxFps;
            }
        }
        if (settings.antiLag.levelSupported && settings.antiLag.level == ANTILAGNEXT)
            antiLagNextDetected = true;

        state.gpus.push_back(snapshot);
    }

    state.detected = !state.gpus.empty();
    if (antiLagNextDetected) state.warnings.push_back("antiLagNext");
}

const GpuSnapshot* findSnapshot(const std::vector<GpuSnapshot>& list, const GpuSnapshot& target)
{
    if (target.uniqueId >= 0)
    {
        for (const GpuSnapshot& candidate : list)
        {
            if (candidate.uniqueId == target.uniqueId) return &candidate;
        }
    }
    for (const GpuSnapshot& candidate : list)
    {
        if (candidate.listIndex == target.listIndex) return &candidate;
    }
    return nullptr;
}

bool verifyApplied(const std::vector<GpuSnapshot>& current, std::string& error)
{
    for (const GpuSnapshot& snapshot : current)
    {
        const GpuSettings& settings = snapshot.settings;
        if (settings.verticalSyncSupported && settings.verticalSyncMode != WFVR_ALWAYS_OFF)
        {
            error = "수직 동기화 끄기 적용을 확인하지 못했습니다";
            return false;
        }
        if (settings.enhancedSyncSupported && settings.enhancedSyncEnabled)
        {
            error = "Enhanced Sync 끄기 적용을 확인하지 못했습니다";
            return false;
        }
        if (settings.chillSupported && settings.chillEnabled)
        {
            error = "Radeon Chill 끄기 적용을 확인하지 못했습니다";
            return false;
        }
        if (settings.antiLag.supported && !settings.antiLag.enabled)
        {
            error = "Radeon Anti-Lag 켜기 적용을 확인하지 못했습니다";
            return false;
        }
        if (settings.antiLag.levelSupported && settings.antiLag.level != ANTILAG)
        {
            error = "Radeon Anti-Lag 레벨 적용을 확인하지 못했습니다";
            return false;
        }
    }
    return true;
}

bool verifyRestored(
    const std::vector<GpuSnapshot>& current,
    const std::vector<GpuSnapshot>& receipt,
    std::string& error)
{
    for (const GpuSnapshot& expected : receipt)
    {
        const GpuSnapshot* actual = findSnapshot(current, expected);
        if (actual == nullptr)
        {
            error = "복구한 GPU 설정을 다시 확인하지 못했습니다";
            return false;
        }
        const GpuSettings& before = expected.settings;
        const GpuSettings& now = actual->settings;
        if (before.verticalSyncSupported && now.verticalSyncMode != before.verticalSyncMode)
        {
            error = "수직 동기화 설정 복구를 확인하지 못했습니다";
            return false;
        }
        if (before.enhancedSyncSupported && now.enhancedSyncEnabled != before.enhancedSyncEnabled)
        {
            error = "Enhanced Sync 설정 복구를 확인하지 못했습니다";
            return false;
        }
        if (before.chillSupported && now.chillEnabled != before.chillEnabled)
        {
            error = "Radeon Chill 설정 복구를 확인하지 못했습니다";
            return false;
        }
        if (before.antiLag.supported && now.antiLag.enabled != before.antiLag.enabled)
        {
            error = "Radeon Anti-Lag 설정 복구를 확인하지 못했습니다";
            return false;
        }
        if (before.antiLag.levelSupported
            && now.antiLag.levelSupported
            && now.antiLag.level != before.antiLag.level)
        {
            error = "Radeon Anti-Lag 레벨 복구를 확인하지 못했습니다";
            return false;
        }
    }
    return true;
}

void runProbeCommand(
    DaemonState& state,
    IADLXGPUList* gpus,
    IADLX3DSettingsServices* services)
{
    refreshSnapshot(state, gpus, services);
    if (!state.detected)
    {
        state.lastResult = "error";
        state.error = "AMD Radeon GPU를 찾지 못했습니다";
        return;
    }
    state.lastResult = "ok";
    state.error.clear();
}

void runApplyCommand(
    DaemonState& state,
    IADLXGPUList* gpus,
    IADLX3DSettingsServices* services,
    const fs::path& statusPath,
    const fs::path& receiptPath)
{
    refreshSnapshot(state, gpus, services);
    if (!state.detected)
    {
        state.lastResult = "error";
        state.error = "AMD Radeon GPU를 찾지 못했습니다";
        return;
    }

    // 안전 규칙: 현재 레벨이 Anti-Lag Next이면 사용자의 설정을 그대로 두고
    // 적용을 거부한다. 여기서 Set* 호출을 하나라도 하면 안 된다.
    for (const GpuSnapshot& snapshot : state.gpus)
    {
        if (snapshot.settings.antiLag.levelSupported
            && snapshot.settings.antiLag.level == ANTILAGNEXT)
        {
            state.lastResult = "refused";
            state.error =
                "Radeon Anti-Lag Next가 켜져 있어 설정을 변경하지 않았습니다";
            return;
        }
    }

    // 순서가 중요하다: before 스냅샷(영수증)을 먼저 디스크에 남긴 뒤에야
    // Set* 호출을 시작한다. 반대로 하면 적용 도중 죽었을 때 사용자의 원래
    // 설정을 되돌릴 방법이 사라진다.
    state.receipt = state.gpus;
    state.receiptCapturedAt = currentTimeMs();
    state.receiptApplied = false;
    state.hasReceipt = true;
    if (!writeFileAtomic(receiptPath, buildReceiptJson(state)))
    {
        state.hasReceipt = false;
        state.receipt.clear();
        state.lastResult = "error";
        state.error = "설정 복구 기록을 저장하지 못해 적용을 중단했습니다";
        return;
    }
    writeFileAtomic(statusPath, buildStatusJson(state));

    std::string failure;
    for (const GpuSnapshot& snapshot : state.receipt)
    {
        IADLXGPU* gpu = nullptr;
        if (!ADLX_SUCCEEDED(gpus->At(snapshot.listIndex, &gpu)) || gpu == nullptr)
        {
            if (failure.empty()) failure = "AMD GPU 설정을 다시 열지 못했습니다";
            continue;
        }
        applyGpuSettings(services, gpu, snapshot.settings, failure);
        releaseInterface(gpu);
    }

    refreshSnapshot(state, gpus, services);
    if (failure.empty()) verifyApplied(state.gpus, failure);
    state.receiptApplied = failure.empty();
    writeFileAtomic(receiptPath, buildReceiptJson(state));
    if (failure.empty())
    {
        state.lastResult = "ok";
        state.error.clear();
        return;
    }
    state.lastResult = "error";
    state.error = failure;
}

// 영수증 되읽기.
//
// runApplyCommand는 Set* 호출 전에 영수증을 디스크에 남긴다. 그런데 그 파일을 다시
// 읽는 쪽이 없으면 앱이나 daemon이 죽는 순간 사용자의 원래 설정을 되돌릴 방법이
// 사라진다. 아래는 그 되읽기 경로이며, 영수증은 이 helper가 직접 쓴 파일이라 형태가
// 고정되어 있으므로 takeControlCommand와 같은 이유로 외부 JSON 파서를 들이지 않고
// 키 구간을 잘라 읽는다.

bool verticalSyncModeFromKey(const std::string& key, ADLX_WAIT_FOR_VERTICAL_REFRESH_MODE& mode)
{
    if (key == "alwaysOff") { mode = WFVR_ALWAYS_OFF; return true; }
    if (key == "offUnlessAppSpecifies") { mode = WFVR_OFF_UNLESS_APP_SPECIFIES; return true; }
    if (key == "onUnlessAppSpecifies") { mode = WFVR_ON_UNLESS_APP_SPECIFIES; return true; }
    if (key == "alwaysOn") { mode = WFVR_ALWAYS_ON; return true; }
    return false;
}

size_t findJsonKey(const std::string& text, size_t from, size_t limit, const std::string& key)
{
    const std::string needle = "\"" + key + "\":";
    const size_t found = text.find(needle, from);
    if (found == std::string::npos || found + needle.size() > limit) return std::string::npos;
    return found + needle.size();
}

// key 가 가리키는 중괄호 객체의 [begin, end) 구간을 돌려준다.
bool findJsonObject(
    const std::string& text,
    size_t from,
    size_t limit,
    const std::string& key,
    size_t& begin,
    size_t& end)
{
    const size_t start = findJsonKey(text, from, limit, key);
    if (start == std::string::npos || start >= text.size() || text[start] != '{') return false;
    int depth = 0;
    for (size_t index = start; index < text.size() && index < limit; ++index)
    {
        if (text[index] == '{') ++depth;
        else if (text[index] == '}' && --depth == 0)
        {
            begin = start;
            end = index + 1;
            return true;
        }
    }
    return false;
}

bool readJsonBool(
    const std::string& text, size_t from, size_t limit, const std::string& key, bool& value)
{
    const size_t start = findJsonKey(text, from, limit, key);
    if (start == std::string::npos) return false;
    if (text.compare(start, 4, "true") == 0) { value = true; return true; }
    if (text.compare(start, 5, "false") == 0) { value = false; return true; }
    return false;
}

bool readJsonNumber(
    const std::string& text, size_t from, size_t limit, const std::string& key, long long& value)
{
    const size_t start = findJsonKey(text, from, limit, key);
    if (start == std::string::npos) return false;
    size_t digits = start;
    if (digits < text.size() && (text[digits] == '-' || text[digits] == '+')) ++digits;
    const size_t firstDigit = digits;
    while (digits < text.size() && text[digits] >= '0' && text[digits] <= '9') ++digits;
    if (digits == firstDigit) return false;
    value = std::strtoll(text.c_str() + start, nullptr, 10);
    return true;
}

bool readJsonString(
    const std::string& text, size_t from, size_t limit, const std::string& key, std::string& value)
{
    const size_t start = findJsonKey(text, from, limit, key);
    if (start == std::string::npos || start >= text.size() || text[start] != '"') return false;
    const size_t close = text.find('"', start + 1);
    if (close == std::string::npos || close >= limit) return false;
    value = text.substr(start + 1, close - start - 1);
    return true;
}

// buildSettingsJson 이 만든 구간을 그대로 되읽는다. 하나라도 모양이 다르면 통째로
// 버린다. 반쯤 읽은 영수증으로 사용자의 설정을 건드리는 편보다 되돌리기를 포기하고
// 사람이 직접 고치게 두는 편이 안전하다.
bool parseSettingsJson(const std::string& text, size_t begin, size_t end, GpuSettings& settings)
{
    size_t objectBegin = 0;
    size_t objectEnd = 0;

    if (!findJsonObject(text, begin, end, "verticalSync", objectBegin, objectEnd)) return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "supported", settings.verticalSyncSupported))
        return false;
    if (settings.verticalSyncSupported)
    {
        std::string mode;
        if (!readJsonString(text, objectBegin, objectEnd, "mode", mode)) return false;
        if (!verticalSyncModeFromKey(mode, settings.verticalSyncMode)) return false;
    }

    if (!findJsonObject(text, begin, end, "enhancedSync", objectBegin, objectEnd)) return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "supported", settings.enhancedSyncSupported))
        return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "enabled", settings.enhancedSyncEnabled))
        return false;

    if (!findJsonObject(text, begin, end, "chill", objectBegin, objectEnd)) return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "supported", settings.chillSupported))
        return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "enabled", settings.chillEnabled)) return false;

    if (!findJsonObject(text, begin, end, "antiLag", objectBegin, objectEnd)) return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "supported", settings.antiLag.supported))
        return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "enabled", settings.antiLag.enabled))
        return false;
    if (!readJsonBool(
            text, objectBegin, objectEnd, "levelSupported", settings.antiLag.levelSupported))
        return false;
    if (settings.antiLag.levelSupported)
    {
        std::string level;
        if (!readJsonString(text, objectBegin, objectEnd, "level", level)) return false;
        // 안전 규칙: 영수증에 Anti-Lag Next가 들어 있을 수는 없지만(그 경우 적용 자체를
        // 거부한다), 손으로 고친 파일까지 신뢰하지는 않는다. antiLag 이외의 값은 버린다.
        if (level != "antiLag") return false;
        settings.antiLag.level = ANTILAG;
    }

    if (!findJsonObject(text, begin, end, "frameRateTarget", objectBegin, objectEnd)) return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "supported", settings.frameRateTarget.supported))
        return false;
    if (!readJsonBool(text, objectBegin, objectEnd, "enabled", settings.frameRateTarget.enabled))
        return false;
    long long fps = 0;
    if (!readJsonNumber(text, objectBegin, objectEnd, "fps", fps)) return false;
    settings.frameRateTarget.fps = static_cast<adlx_int>(fps);
    long long minFps = 0;
    long long maxFps = 0;
    if (readJsonNumber(text, objectBegin, objectEnd, "minFps", minFps)
        && readJsonNumber(text, objectBegin, objectEnd, "maxFps", maxFps))
    {
        settings.frameRateTarget.rangeKnown = true;
        settings.frameRateTarget.minFps = static_cast<adlx_int>(minFps);
        settings.frameRateTarget.maxFps = static_cast<adlx_int>(maxFps);
    }
    return true;
}

// 기동 시 남아있는 영수증을 되읽어 되돌리기 대상으로 삼는다. 지금 붙어 있는 GPU가
// 영수증에 적힌 GPU와 uniqueId 로 모두 맞아떨어질 때만 받아들인다. 그래픽카드를
// 바꿔 끼운 PC에서 남의 설정을 덮어쓰지 않기 위한 조건이다.
bool loadReceipt(const fs::path& receiptPath, DaemonState& state)
{
    std::ifstream input(receiptPath, std::ios::binary);
    if (!input) return false;
    std::ostringstream contents;
    contents << input.rdbuf();
    input.close();
    const std::string text = contents.str();
    if (text.empty()) return false;

    long long version = 0;
    if (!readJsonNumber(text, 0, text.size(), "version", version) || version != 1) return false;

    const size_t listStart = findJsonKey(text, 0, text.size(), "gpus");
    if (listStart == std::string::npos || listStart >= text.size() || text[listStart] != '[')
        return false;

    std::vector<GpuSnapshot> receipt;
    size_t cursor = listStart;
    for (;;)
    {
        const size_t indexAt = findJsonKey(text, cursor, text.size(), "index");
        if (indexAt == std::string::npos) break;
        long long listIndex = 0;
        long long uniqueId = -1;
        if (!readJsonNumber(text, cursor, text.size(), "index", listIndex)) return false;
        if (!readJsonNumber(text, indexAt, text.size(), "uniqueId", uniqueId)) return false;
        GpuSnapshot snapshot;
        snapshot.listIndex = static_cast<adlx_uint>(listIndex);
        snapshot.uniqueId = static_cast<adlx_int>(uniqueId);
        readJsonString(text, indexAt, text.size(), "name", snapshot.name);
        size_t begin = 0;
        size_t end = 0;
        if (!findJsonObject(text, indexAt, text.size(), "before", begin, end)) return false;
        if (!parseSettingsJson(text, begin, end, snapshot.settings)) return false;
        receipt.push_back(snapshot);
        cursor = end;
    }
    if (receipt.empty()) return false;

    for (const GpuSnapshot& snapshot : receipt)
    {
        if (snapshot.uniqueId < 0) return false;
        bool matched = false;
        for (const GpuSnapshot& candidate : state.gpus)
        {
            if (candidate.uniqueId == snapshot.uniqueId) matched = true;
        }
        if (!matched) return false;
    }

    long long capturedAt = 0;
    readJsonNumber(text, 0, text.size(), "capturedAt", capturedAt);
    bool applied = false;
    readJsonBool(text, 0, text.size(), "applied", applied);

    state.receipt = receipt;
    state.receiptCapturedAt = capturedAt;
    state.receiptApplied = applied;
    state.hasReceipt = true;
    return true;
}

void runRestoreCommand(
    DaemonState& state,
    IADLXGPUList* gpus,
    IADLX3DSettingsServices* services,
    const fs::path& receiptPath)
{
    if (!state.hasReceipt || state.receipt.empty())
    {
        state.lastResult = "error";
        state.error = "되돌릴 이전 설정 기록이 없습니다";
        return;
    }

    std::string failure;
    for (const GpuSnapshot& snapshot : state.receipt)
    {
        IADLXGPU* gpu = nullptr;
        if (!ADLX_SUCCEEDED(gpus->At(snapshot.listIndex, &gpu)) || gpu == nullptr)
        {
            if (failure.empty()) failure = "AMD GPU 설정을 다시 열지 못했습니다";
            continue;
        }
        restoreGpuSettings(services, gpu, snapshot.settings, failure);
        releaseInterface(gpu);
    }

    const std::vector<GpuSnapshot> receipt = state.receipt;
    refreshSnapshot(state, gpus, services);
    if (failure.empty()) verifyRestored(state.gpus, receipt, failure);
    if (!failure.empty())
    {
        state.lastResult = "error";
        state.error = failure;
        return;
    }

    state.hasReceipt = false;
    state.receiptApplied = false;
    state.receipt.clear();
    std::error_code error;
    fs::remove(receiptPath, error);
    state.lastResult = "ok";
    state.error.clear();
}

bool parseDaemonOptions(int argc, wchar_t** argv, DaemonOptions& options)
{
    for (int index = 1; index < argc; ++index)
    {
        const std::wstring argument = argv[index];
        if (argument == L"--legacy-driver")
        {
            options.legacyDriver = true;
            continue;
        }
        if (argument.rfind(L"--", 0) != 0) continue;
        const size_t separator = argument.find(L'=');
        if (separator == std::wstring::npos) continue;
        const std::wstring name = argument.substr(2, separator - 2);
        const std::wstring value = argument.substr(separator + 1);
        if (name == L"status-path") options.statusPath = value;
        else if (name == L"control-path") options.controlPath = value;
        else if (name == L"parent-pid")
        {
            options.parentPid = static_cast<DWORD>(std::wcstoul(value.c_str(), nullptr, 10));
        }
    }
    return !options.statusPath.empty()
        && !options.controlPath.empty()
        && options.parentPid != 0;
}

int runDaemon(const DaemonOptions& options)
{
    const fs::path statusPath(options.statusPath);
    const fs::path controlPath(options.controlPath);
    const fs::path receiptPath = receiptPathFor(statusPath);

    DaemonState state;
    state.legacyDriver = options.legacyDriver;

    HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\NogiremRadeon");
    if (mutex == nullptr || GetLastError() == ERROR_ALREADY_EXISTS)
    {
        if (mutex != nullptr) CloseHandle(mutex);
        state.lastResult = "error";
        state.error = "Radeon 설정 daemon이 이미 실행 중입니다";
        writeFileAtomic(statusPath, buildStatusJson(state));
        return 2;
    }

    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, options.parentPid);
    if (parent == nullptr)
    {
        state.lastResult = "error";
        state.error = "부모 프로세스를 확인하지 못했습니다";
        writeFileAtomic(statusPath, buildStatusJson(state));
        ReleaseMutex(mutex);
        CloseHandle(mutex);
        return 1;
    }

    std::error_code fileError;
    fs::remove(controlPath, fileError);

    ADLX_RESULT result = options.legacyDriver
        ? g_ADLX.InitializeWithIncompatibleDriver()
        : g_ADLX.Initialize();
    if (!options.legacyDriver && !ADLX_SUCCEEDED(result))
    {
        g_ADLX.Terminate();
        result = g_ADLX.InitializeWithIncompatibleDriver();
        if (ADLX_SUCCEEDED(result)) state.legacyDriver = true;
    }
    if (!ADLX_SUCCEEDED(result))
    {
        g_ADLX.Terminate();
        state.lastResult = "error";
        state.error = "AMD ADLX 초기화 실패: " + std::to_string(static_cast<int>(result));
        writeFileAtomic(statusPath, buildStatusJson(state));
        CloseHandle(parent);
        ReleaseMutex(mutex);
        CloseHandle(mutex);
        return 1;
    }

    IADLXSystem* system = g_ADLX.GetSystemServices();
    IADLXGPUList* gpus = nullptr;
    IADLX3DSettingsServices* services = nullptr;
    result = system == nullptr ? ADLX_FAIL : system->GetGPUs(&gpus);
    if (ADLX_SUCCEEDED(result)) result = system->Get3DSettingsServices(&services);
    if (!ADLX_SUCCEEDED(result) || gpus == nullptr || services == nullptr)
    {
        releaseInterface(services);
        releaseInterface(gpus);
        g_ADLX.Terminate();
        state.lastResult = "error";
        state.error = "AMD GPU 설정 서비스를 찾지 못했습니다";
        writeFileAtomic(statusPath, buildStatusJson(state));
        CloseHandle(parent);
        ReleaseMutex(mutex);
        CloseHandle(mutex);
        return 1;
    }

    state.running = true;
    try
    {
        refreshSnapshot(state, gpus, services);
    }
    catch (...)
    {
        state.lastResult = "error";
        state.error = "Radeon 설정 조회 중 오류가 발생했습니다";
    }
    // 남아있는 영수증을 되읽는다. 앱이나 daemon이 적용 도중/직후에 죽어도 다음 기동에서
    // 사용자의 원래 설정으로 되돌릴 수 있어야 한다.
    if (state.detected && loadReceipt(receiptPath, state))
        writeFileAtomic(statusPath, buildStatusJson(state));

    ULONGLONG nextRefresh = GetTickCount64() + daemonRefreshIntervalMs;
    while (true)
    {
        if (!processRunning(parent)) break;

        const std::string command = takeControlCommand(controlPath);
        if (command == "stop")
        {
            state.lastCommand = command;
            state.lastResult = "ok";
            break;
        }

        bool changed = false;
        if (!command.empty())
        {
            state.lastCommand = command;
            state.lastResult.clear();
            state.error.clear();
            try
            {
                if (command == "probe") runProbeCommand(state, gpus, services);
                else if (command == "apply")
                    runApplyCommand(state, gpus, services, statusPath, receiptPath);
                else if (command == "restore")
                    runRestoreCommand(state, gpus, services, receiptPath);
            }
            catch (...)
            {
                state.lastResult = "error";
                state.error = "Radeon 설정 처리 중 오류가 발생했습니다";
            }
            changed = true;
        }

        if (!changed && GetTickCount64() >= nextRefresh)
        {
            try
            {
                refreshSnapshot(state, gpus, services);
            }
            catch (...)
            {
                state.lastResult = "error";
                state.error = "Radeon 설정 조회 중 오류가 발생했습니다";
            }
            changed = true;
        }

        if (changed)
        {
            nextRefresh = GetTickCount64() + daemonRefreshIntervalMs;
            writeFileAtomic(statusPath, buildStatusJson(state));
        }
        Sleep(daemonTickIntervalMs);
    }

    state.running = false;
    writeFileAtomic(statusPath, buildStatusJson(state));
    releaseInterface(services);
    releaseInterface(gpus);
    g_ADLX.Terminate();
    CloseHandle(parent);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return 0;
}

int runHelper(int argc, wchar_t** argv)
{
    bool daemon = false;
    bool apply = false;
    bool legacyDriver = false;
    for (int index = 1; index < argc; ++index)
    {
        const std::wstring argument = argv[index];
        if (argument == L"--daemon") daemon = true;
        if (argument == L"--apply") apply = true;
        if (argument == L"--legacy-driver") legacyDriver = true;
    }

    if (!daemon) return runOneShot(apply, legacyDriver);

    DaemonOptions options;
    if (!parseDaemonOptions(argc, argv, options))
    {
        if (!options.statusPath.empty())
        {
            DaemonState state;
            state.legacyDriver = legacyDriver;
            state.lastResult = "error";
            state.error = "필수 실행 인자가 없습니다";
            writeFileAtomic(fs::path(options.statusPath), buildStatusJson(state));
        }
        return 3;
    }
    return runDaemon(options);
}

int wmain(int argc, wchar_t** argv)
{
    SetConsoleOutputCP(CP_UTF8);
    int exitCode = 0;
    __try
    {
        exitCode = runHelper(argc, argv);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        std::printf(
            "{\"detected\":false,\"gpus\":[],\"goals\":[],\"allMet\":false,"
            "\"reason\":\"AMD \\ub4dc\\ub77c\\uc774\\ubc84 \\uc124\\uc815 API "
            "\\uc2e4\\ud589 \\uc911 \\uc624\\ub958\\uac00 \\ubc1c\\uc0dd"
            "\\ud588\\uc2b5\\ub2c8\\ub2e4 (0x%08lX)\"}\n",
            GetExceptionCode());
        exitCode = 0;
    }
    std::cout.flush();
    std::cerr.flush();
    std::fflush(nullptr);
    ExitProcess(static_cast<UINT>(exitCode));
}
