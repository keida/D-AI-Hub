[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandText,

  [Parameter(Mandatory = $false)]
  [string]$TaskId,

  [Parameter(Mandatory = $false)]
  [string]$WorkspacePath = (Get-Location).Path,

  [Parameter(Mandatory = $false)]
  [string]$CurationPayloadPath,

  [Parameter(Mandatory = $false)]
  [string]$MemoryDatabasePath
)

$ErrorActionPreference = 'Stop'

function Write-Blocked([string]$Message) {
  [Console]::Out.WriteLine((([ordered]@{
        status = 'blocked'
        taskId = 'unassigned'
        environment = 'codex'
        stage = 'bootstrap'
        message = $Message
      } | ConvertTo-Json -Compress)))
}

function Assert-FullyQualifiedPath([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label is empty"
  }
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') {
    throw "$Label must be a fully qualified absolute path"
  }
}

function Resolve-Directory([string]$Path, [string]$Label) {
  Assert-FullyQualifiedPath $Path $Label
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  $item = Get-Item -LiteralPath $resolved.Path -Force
  if (-not $item.PSIsContainer) {
    throw "$Label is not a directory: $Path"
  }
  return $resolved.Path
}

function Assert-CurationInputs {
  if (-not [string]::IsNullOrWhiteSpace($CurationPayloadPath)) {
    Assert-FullyQualifiedPath $CurationPayloadPath 'Curation payload path'
    if (-not (Test-Path -LiteralPath $CurationPayloadPath -PathType Leaf)) {
      throw 'Curation payload is not readable'
    }
    Get-Content -LiteralPath $CurationPayloadPath -Raw -ErrorAction Stop | Out-Null
  }
  if (-not [string]::IsNullOrWhiteSpace($MemoryDatabasePath)) {
    Assert-FullyQualifiedPath $MemoryDatabasePath 'Memory database path'
  }
}

function Assert-InstalledSkillRoot([string]$Candidate) {
  Assert-FullyQualifiedPath $Candidate 'Installed D-AI Skill root'
  $skillManifestPath = Join-Path $Candidate 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillManifestPath -PathType Leaf)) {
    throw 'Installed D-AI Skill root is invalid: SKILL.md is missing'
  }
  $skillManifest = Get-Content -LiteralPath $skillManifestPath -Raw
  if ($skillManifest -notmatch '(?m)^name:\s*d-ai\s*$') {
    throw 'Installed D-AI Skill root is invalid: SKILL.md is not the d-ai Skill'
  }
  foreach ($scriptName in @('invoke.ps1', 'set-runtime-binding.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate "scripts\\$scriptName") -PathType Leaf)) {
      throw "Installed D-AI Skill root is invalid: scripts/$scriptName is missing"
    }
  }
}

function Test-RuntimeRoot([string]$Candidate, [ref]$FailureReason) {
  try {
    $packagePath = Join-Path $Candidate 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
      throw 'package.json is missing'
    }
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$package.scripts.'d-ai')) {
      throw 'package.json does not define the d-ai npm script'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'src\entry\codex-cli.ts') -PathType Leaf)) {
      throw 'canonical D-AI Codex entry is missing'
    }
    return $true
  } catch {
    $FailureReason.Value = $_.Exception.Message
    return $false
  }
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = $null
try {
  Assert-CurationInputs
  Assert-InstalledSkillRoot $skillRoot
  $bindingPath = Join-Path $skillRoot '.runtime-root'
  if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
    throw "Installed D-AI runtime binding is missing: $bindingPath"
  }
  $bindingValue = (Get-Content -LiteralPath $bindingPath -Raw).Trim()
  $repositoryRoot = Resolve-Directory $bindingValue 'Installed D-AI runtime binding'
  $failureReason = ''
  if (-not (Test-RuntimeRoot $repositoryRoot ([ref]$failureReason))) {
    throw "Installed D-AI runtime binding is invalid: $failureReason"
  }
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
} catch {
  Write-Blocked $_.Exception.Message
  exit 2
}

$arguments = @(
  '--silent',
  '--prefix',
  $repositoryRoot,
  'run',
  'd-ai',
  '--',
  '--workspace',
  $WorkspacePath,
  '--command',
  $CommandText
)
if (-not [string]::IsNullOrWhiteSpace($TaskId)) {
  $arguments += @('--task', $TaskId)
}
if (-not [string]::IsNullOrWhiteSpace($CurationPayloadPath)) {
  $arguments += @('--curation-payload', $CurationPayloadPath)
}
if (-not [string]::IsNullOrWhiteSpace($MemoryDatabasePath)) {
  $arguments += @('--memory-database', $MemoryDatabasePath)
}

& $npm @arguments
exit $LASTEXITCODE
