[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandText,

  [Parameter(Mandatory = $false)]
  [string]$TaskId,

  [Parameter(Mandatory = $false)]
  [string]$WorkspacePath = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$skillEntry = Get-Item -LiteralPath $skillRoot -Force
$canonicalSkillRoot = if ($null -ne $skillEntry.Target -and $skillEntry.Target.Count -gt 0) {
  (Resolve-Path -LiteralPath @($skillEntry.Target)[0]).Path
} else {
  (Resolve-Path -LiteralPath $skillRoot).Path
}
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $canonicalSkillRoot '..\..\..')).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
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

& $npm @arguments
exit $LASTEXITCODE
