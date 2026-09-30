<#
Run Codex with the sdlc suite on a local Qwen3.8-27B served by Ollama.

    .codex\run-qwen-local.ps1                      # interactive
    .codex\run-qwen-local.ps1 exec "Use the orchestrator agent to ..."

Uses its own Codex home (default ~\.codex-qwen), so your normal ~\.codex setup
(model, login, MCP servers, user agents) is neither read nor changed. That
home's config.toml is rewritten on every launch. It trusts this repository,
without which Codex skips .codex\agents\, and points at Ollama through a
provider of its own, because the built-in `ollama` provider cannot be
reconfigured and its 5-minute stream idle timeout is shorter than prompt
processing takes when the model runs mostly on CPU.

Environment overrides: QWEN_SDLC_MODEL, QWEN_SDLC_OLLAMA_URL, QWEN_SDLC_CODEX_HOME.
#>
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Model = if ($env:QWEN_SDLC_MODEL) { $env:QWEN_SDLC_MODEL } else { 'qwen3.8-27b-sdlc' }
$Ollama = if ($env:QWEN_SDLC_OLLAMA_URL) { $env:QWEN_SDLC_OLLAMA_URL.TrimEnd('/') } else { 'http://localhost:11434' }
$CodexHome = if ($env:QWEN_SDLC_CODEX_HOME) { $env:QWEN_SDLC_CODEX_HOME } else { Join-Path $HOME '.codex-qwen' }
# Keep equal to num_ctx in Modelfile.qwen3.8-27b.
$ContextWindow = 32768

# Both values are written into TOML strings below. Allowlist, not denylist:
# a newline, quote or backslash would add keys to the config.
if ($Model -cnotmatch '^[A-Za-z0-9._:/-]+\z') {
    Write-Host "QWEN_SDLC_MODEL may contain only letters, digits and . _ : / -: $Model" -ForegroundColor Red
    exit 2
}
if ($Ollama -cnotmatch '^https?://[A-Za-z0-9._:/-]+\z') {
    Write-Host "QWEN_SDLC_OLLAMA_URL must be a plain http(s) URL: $Ollama" -ForegroundColor Red
    exit 2
}

try {
    $tags = Invoke-RestMethod -Uri "$Ollama/api/tags" -TimeoutSec 5
} catch {
    Write-Host "Ollama is not reachable at $Ollama. Start the Ollama app, then retry." -ForegroundColor Red
    exit 2
}
$names = @($tags.models | ForEach-Object { $_.name })
if (-not (($names -contains $Model) -or ($names -contains "${Model}:latest"))) {
    Write-Host "Model '$Model' is not in Ollama. Build it once:" -ForegroundColor Red
    Write-Host "  ollama pull qwen3.8:27b"
    Write-Host "  ollama create $Model -f `"$PSScriptRoot\Modelfile.qwen3.8-27b`""
    exit 2
}

# Codex matches trust entries against the lowercased path on Windows only.
$TrustKey = if ([Environment]::OSVersion.Platform -eq 'Win32NT') { $Repo.ToLowerInvariant() } else { $Repo }
if ($TrustKey.Contains("'")) {
    Write-Host "Repository path contains a single quote, which this script cannot write as a TOML key: $Repo" -ForegroundColor Red
    exit 2
}

$config = @"
# WRITTEN BY .codex/run-qwen-local.ps1 ON EVERY LAUNCH. Edits here are overwritten.
model = "$Model"
model_provider = "qwen_local"
model_context_window = $ContextWindow

[model_providers.qwen_local]
name = "Ollama (local Qwen)"
base_url = "$Ollama/v1"
wire_api = "responses"
stream_idle_timeout_ms = 3600000
request_max_retries = 1
stream_max_retries = 1

[projects.'$TrustKey']
trust_level = "trusted"
"@

# Trusting the repo makes Codex load project-scoped files from .codex/ (config,
# hooks, rules), some of which can run or approve commands. Allowlist what this
# repository ships there; anything else (a branch, a merge) stops the launch
# rather than being trusted silently. Keep in step with run-qwen-local.sh.
$Known = @('agents', 'skills', 'README.md', 'Modelfile.qwen3.8-27b', 'run-qwen-local.ps1', 'run-qwen-local.sh', 'convert-agents.py', 'sync-skills.py', '__pycache__')
$Unknown = @(Get-ChildItem -LiteralPath $PSScriptRoot -Force | Where-Object { $Known -notcontains $_.Name })
if ($Unknown.Count -gt 0) {
    Write-Host "Refusing to trust ${Repo}: unexpected entries in .codex: $($Unknown.Name -join ', '). Review them first." -ForegroundColor Red
    exit 2
}

$ConfigPath = Join-Path $CodexHome 'config.toml'
$Header = '# WRITTEN BY .codex/run-qwen-local'
$ForeignHome = if (Test-Path -LiteralPath $ConfigPath) {
    -not ([IO.File]::ReadAllText($ConfigPath).StartsWith($Header))
} else {
    # No config yet: fine for a new or empty directory, not for an existing
    # Codex home that simply has no config.toml (auth.json, sessions, ...).
    (Test-Path -LiteralPath $CodexHome) -and @(Get-ChildItem -LiteralPath $CodexHome -Force).Count -gt 0
}
if ($ForeignHome) {
    Write-Host "Refusing to overwrite ${ConfigPath}: this launcher did not write it (is QWEN_SDLC_CODEX_HOME your real Codex home?)." -ForegroundColor Red
    exit 2
}
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
[IO.File]::WriteAllText($ConfigPath, $config.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding $false))

$env:CODEX_HOME = $CodexHome
# Back to Continue before handing over: under Windows PowerShell 5.1, 'Stop'
# turns anything Codex writes to stderr (it prints progress there) into a
# terminating NativeCommandError, and the launcher died on the first line.
$ErrorActionPreference = 'Continue'
& codex -C $Repo @args
exit $LASTEXITCODE
