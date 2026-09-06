[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SkillRoot,

  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'

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

function Assert-RuntimeRoot([string]$Candidate) {
  $packagePath = Join-Path $Candidate 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Runtime root is invalid: package.json is missing"
  }
  $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$package.scripts.'d-ai')) {
    throw "Runtime root is invalid: package.json does not define the d-ai npm script"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'src\entry\codex-cli.ts') -PathType Leaf)) {
    throw 'Runtime root is invalid: canonical D-AI Codex entry is missing'
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

$skillItem = Get-Item -LiteralPath $SkillRoot -Force
Assert-FullyQualifiedPath $SkillRoot 'Installed D-AI Skill root'
if (-not $skillItem.PSIsContainer) {
  throw "Installed D-AI Skill root is not a directory: $SkillRoot"
}
$resolvedSkillRoot = $skillItem.FullName
Assert-InstalledSkillRoot $resolvedSkillRoot
$resolvedRuntimeRoot = Resolve-Directory $RuntimeRoot 'D-AI runtime root'
Assert-RuntimeRoot $resolvedRuntimeRoot
$bindingPath = Join-Path $resolvedSkillRoot '.runtime-root'
$existing = if (Test-Path -LiteralPath $bindingPath -PathType Leaf) { (Get-Content -LiteralPath $bindingPath -Raw).Trim() } else { $null }
if ($existing -eq $resolvedRuntimeRoot) {
  [Console]::Out.WriteLine((([ordered]@{ status = 'unchanged'; bindingPath = $bindingPath; runtimeRoot = $resolvedRuntimeRoot } | ConvertTo-Json -Compress)))
  exit 0
}

$temporaryPath = "$bindingPath.$([guid]::NewGuid().ToString('N')).tmp"
try {
  [System.IO.File]::WriteAllText($temporaryPath, "$resolvedRuntimeRoot`r`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $bindingPath -Force
} finally {
  if (Test-Path -LiteralPath $temporaryPath) {
    Remove-Item -LiteralPath $temporaryPath -Force
  }
}
[Console]::Out.WriteLine((([ordered]@{ status = if ($null -eq $existing) { 'created' } else { 'updated' }; bindingPath = $bindingPath; runtimeRoot = $resolvedRuntimeRoot } | ConvertTo-Json -Compress)))
