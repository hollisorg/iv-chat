param([Parameter(Mandatory)][string]$Scratch)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (!(Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Install Azure CLI and sign in to the Hollis Organization Azure tenant to build a Windows release.'
}
$tenant = & az account show --only-show-errors --query tenantId --output tsv
if ($LASTEXITCODE -ne 0 -or $tenant -ne '8edf2ba4-3fbc-484a-8d40-9994dece5f86') {
  throw 'Sign in to the Hollis Organization Azure tenant with Azure CLI before building.'
}

$dotnet = if ($env:DOTNET_ROOT_X64) { Join-Path $env:DOTNET_ROOT_X64 'dotnet.exe' } elseif ($env:DOTNET_ROOT) { Join-Path $env:DOTNET_ROOT 'dotnet.exe' } else { (Get-Command dotnet.exe -ErrorAction SilentlyContinue).Source }
if (!$dotnet -or !((& $dotnet --list-runtimes) -match '^Microsoft\.NETCore\.App 10\.')) {
  throw 'Install the Microsoft .NET 10 x64 runtime for the pinned Azure Artifact Signing client.'
}

$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$signtool = Get-ChildItem -LiteralPath $sdk -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d+(\.\d+){3}$' -and [version]$_.Name -ge [version]'10.0.22621.0' } |
  Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1
if (!$signtool) { throw 'Install the Windows SDK (22621 or newer) with x64 SignTool.' }

$client = '1.0.151'
$archive = Join-Path $Scratch 'artifact-signing-client.zip'
$clientDir = Join-Path $Scratch 'client'
$uri = "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$client/microsoft.artifactsigning.client.$client.nupkg"
Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $archive
$expectedSha256 = '35375A4BC4E1102DA729FC3D8D9925F774C3BAAE6B8B7FF6398D948CA9AB0D8A'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedSha256) {
  throw 'Unexpected Azure Artifact Signing NuGet package hash.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $clientDir
$dlib = Join-Path $clientDir 'bin\x64\Azure.CodeSigning.Dlib.dll'
$signature = Get-AuthenticodeSignature -LiteralPath $dlib
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Microsoft Corporation') {
  throw 'Azure Artifact Signing client publisher verification failed.'
}
@{ signtool = $signtool; dlib = $dlib } | ConvertTo-Json -Compress
