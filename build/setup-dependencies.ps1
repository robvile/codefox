# CodeFox Dependency Setup
# Runs after installation to check/install Ollama and optionally pull the model

$ErrorActionPreference = "SilentlyContinue"

# ── Helper: check if Ollama is installed ─────────────────────────
function Find-Ollama {
    $paths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "C:\Program Files\Ollama\ollama.exe",
        "C:\Program Files (x86)\Ollama\ollama.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    # Check PATH
    $fromPath = (Get-Command ollama -ErrorAction SilentlyContinue)?.Source
    if ($fromPath) { return $fromPath }
    return $null
}

# ── Helper: check if a model is already pulled ───────────────────
function Test-ModelPulled {
    param($modelName)
    try {
        $list = & ollama list 2>&1 | Out-String
        return $list -match [regex]::Escape($modelName.Split(':')[0])
    } catch { return $false }
}

# ── Step 1: Check Ollama ─────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms

$ollamaExe = Find-Ollama

if (-not $ollamaExe) {
    $result = [System.Windows.Forms.MessageBox]::Show(
        "Ollama is required for CodeFox to work.`n`nOllama runs AI models locally on your machine. It's free and open source.`n`nClick OK to download and install Ollama now (about 150MB).`nClick Cancel to skip — you can install it later from ollama.com",
        "CodeFox — Install Ollama?",
        [System.Windows.Forms.MessageBoxButtons]::OKCancel,
        [System.Windows.Forms.MessageBoxIcon]::Information
    )

    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        # Download Ollama installer
        $ollamaInstaller = "$env:TEMP\OllamaSetup.exe"
        $progressMsg = "Downloading Ollama installer..."

        [System.Windows.Forms.MessageBox]::Show(
            "Downloading Ollama installer. This may take a moment...`n`nClick OK to begin.",
            "CodeFox — Downloading Ollama",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null

        try {
            $webClient = New-Object System.Net.WebClient
            $webClient.DownloadFile("https://ollama.com/download/OllamaSetup.exe", $ollamaInstaller)

            # Run Ollama installer silently
            $proc = Start-Process -FilePath $ollamaInstaller -ArgumentList "/S" -Wait -PassThru
            if ($proc.ExitCode -eq 0) {
                [System.Windows.Forms.MessageBox]::Show(
                    "Ollama installed successfully!",
                    "CodeFox — Ollama Ready",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                ) | Out-Null
                $ollamaExe = Find-Ollama
            } else {
                [System.Windows.Forms.MessageBox]::Show(
                    "Ollama installer exited with code $($proc.ExitCode).`nPlease install Ollama manually from ollama.com",
                    "CodeFox — Install Failed",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning
                ) | Out-Null
            }
        } catch {
            [System.Windows.Forms.MessageBox]::Show(
                "Could not download Ollama: $_`n`nPlease install it manually from ollama.com",
                "CodeFox — Download Failed",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            ) | Out-Null
        }
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            "No problem — you can install Ollama later from ollama.com`n`nCodeFox will still open, but won't be able to chat until Ollama is running.",
            "CodeFox — Skipping Ollama",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
    }
}

# ── Step 2: Offer to pull a model ────────────────────────────────
if ($ollamaExe) {
    # Start Ollama service if not running
    $ollamaRunning = $false
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 -ErrorAction SilentlyContinue
        $ollamaRunning = ($response.StatusCode -eq 200)
    } catch {}

    if (-not $ollamaRunning) {
        Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
        Start-Sleep -Seconds 3
    }

    # Check if qwen2.5-coder is already pulled
    $modelAlreadyPulled = Test-ModelPulled "qwen2.5-coder"

    if (-not $modelAlreadyPulled) {
        $modelResult = [System.Windows.Forms.MessageBox]::Show(
            "CodeFox works best with a coding model.`n`nRecommended: qwen2.5-coder:32b-instruct`n`n⚠ WARNING: This model is approximately 20GB.`nMake sure you have enough disk space and a stable internet connection before proceeding.`n`nAlternative for smaller GPUs: qwen2.5-coder:7b-instruct (~4GB)`n`nClick YES to download the 32B model (20GB)`nClick NO to download the 7B model (~4GB)`nClick CANCEL to skip — you can pull a model later from the CodeFox settings",
            "CodeFox — Download AI Model",
            [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )

        $modelName = $null
        if ($modelResult -eq [System.Windows.Forms.DialogResult]::Yes) {
            $modelName = "qwen2.5-coder:32b-instruct"
        } elseif ($modelResult -eq [System.Windows.Forms.DialogResult]::No) {
            $modelName = "qwen2.5-coder:7b-instruct"
        }

        if ($modelName) {
            [System.Windows.Forms.MessageBox]::Show(
                "Pulling $modelName...`n`nThis will run in the background. A command window will open showing download progress.`nCodeFox will be ready to use once the download completes.`n`nClick OK to start the download.",
                "CodeFox — Downloading Model",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null

            # Pull model in a visible window so user can see progress
            Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "ollama pull $modelName && echo. && echo Model download complete! You can close this window. && pause" -WindowStyle Normal
        } else {
            [System.Windows.Forms.MessageBox]::Show(
                "Skipping model download.`n`nYou can pull a model later by opening a terminal and running:`n`n  ollama pull qwen2.5-coder:7b-instruct`n`nOr configure a different model in CodeFox settings.",
                "CodeFox — Model Skipped",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null
        }
    }
}

# ── Done ─────────────────────────────────────────────────────────
[System.Windows.Forms.MessageBox]::Show(
    "CodeFox setup complete!`n`nLaunch CodeFox from your desktop or Start Menu.",
    "CodeFox — Ready",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null
