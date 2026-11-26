// Windows release signing. Keep this helper in sync across the IV desktop apps.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const root = path.join(__dirname, '..')
const publisher = 'Hollis Organization Inc'
const profile = {
  Endpoint: 'https://eus.codesigning.azure.net/',
  CodeSigningAccountName: 'infinitevariance',
  CertificateProfileName: 'iv-windows',
  ExcludeCredentials: [
    'EnvironmentCredential', 'ManagedIdentityCredential', 'WorkloadIdentityCredential',
    'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
    'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
  ]
}

function run(exe, args, options = {}) {
  return execFileSync(exe, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options })
}

function powershell(args, options) {
  const flags = ['-NoProfile', '-NonInteractive', ...args]
  try {
    return run('pwsh.exe', flags, options)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const legacy = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const env = { ...process.env, ...options?.env }
    for (const name of Object.keys(env)) {
      if (name.toLowerCase() === 'psmodulepath') delete env[name]
    }
    return run(legacy, flags, { ...options, env })
  }
}

function verifyArtifact(file, tools) {
  run(tools.signtool, ['verify', '/pa', '/all', '/tw', file])
  powershell(['-Command', [
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:IV_VERIFY_FILE',
    '$cert = $sig.SignerCertificate',
    "if ($sig.Status -ne 'Valid' -or !$cert -or !$sig.TimeStamperCertificate) { throw 'Authenticode trust or timestamp verification failed.' }",
    "if ($cert.GetNameInfo('SimpleName', $false) -cne $env:IV_VERIFY_PUBLISHER) { throw 'Unexpected signing publisher.' }"
  ].join('\n')], { env: { ...process.env, IV_VERIFY_FILE: file, IV_VERIFY_PUBLISHER: publisher } })
}

async function verifyUpdateFeed(out, version, expectedInstaller, requireFromBuilder) {
  const yaml = requireFromBuilder('js-yaml')
  const feed = yaml.load(fs.readFileSync(path.join(out, 'latest.yml'), 'utf8'))
  if (feed.version !== version || decodeURIComponent(feed.path) !== expectedInstaller ||
      feed.files.length !== 1 || decodeURIComponent(feed.files[0].url) !== expectedInstaller) {
    throw new Error('latest.yml does not identify the signed installer for this release.')
  }
  const installer = path.join(out, expectedInstaller)
  const hash = createHash('sha512')
  for await (const chunk of fs.createReadStream(installer)) hash.update(chunk)
  const expectedHash = hash.digest('base64')
  if (feed.sha512 !== expectedHash || feed.files[0].sha512 !== expectedHash ||
      feed.files[0].size !== fs.statSync(installer).size ||
      fs.statSync(installer + '.blockmap').size === 0) {
    throw new Error('Update feed or blockmap does not match the signed release installer.')
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--portable', '--publish'].includes(arg))) {
    throw new Error('Usage: node scripts/windows-release.cjs [--portable | --publish]')
  }
  if (process.platform !== 'win32') throw new Error('Windows release signing requires Windows.')
  const localTools = path.join(process.env.LOCALAPPDATA, 'IV', 'ReleaseSigning')
  const azureSession = path.join(localTools, 'azure-session')
  const cliBin = path.join(localTools, 'azure-cli', 'bin')
  const dotnet = path.join(localTools, 'dotnet10')
  if (!process.env.AZURE_CONFIG_DIR && fs.existsSync(azureSession)) process.env.AZURE_CONFIG_DIR = azureSession
  if (fs.existsSync(path.join(cliBin, 'az.cmd'))) process.env.PATH += path.delimiter + cliBin
  if (!process.env.DOTNET_ROOT_X64 && fs.existsSync(path.join(dotnet, 'dotnet.exe'))) {
    process.env.DOTNET_ROOT_X64 = dotnet
  }

  const pkg = require('../package.json')
  const portable = args.includes('--portable')
  const base = portable ? require('../electron-builder.portable.cjs') : pkg.build

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-artifact-signing-'))
  try {
    const tools = JSON.parse(powershell([
      '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(__dirname, 'windows-signing-tools.ps1'), '-Scratch', scratch
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
    const metadata = path.join(scratch, 'metadata.json')
    fs.writeFileSync(metadata, JSON.stringify(profile))

    // The signing callback runs before Electron Builder creates the blockmap and update feed.
    function sign({ path: file, hash }) {
      if (hash !== 'sha256') throw new Error('Windows release signing requires SHA-256.')
      run(tools.signtool, [
        'sign', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com/', '/td', 'SHA256',
        '/dlib', tools.dlib, '/dmdf', metadata, file
      ])
      verifyArtifact(file, tools)
    }

    const out = path.resolve(root, base.directories?.output || 'dist')
    const product = base.productName || pkg.productName || pkg.name
    const app = path.join(out, 'win-unpacked', product + '.exe')
    const installerName = base.nsis.artifactName.replaceAll('$' + '{version}', pkg.version)
    const installer = path.join(out, installerName)
    const signedThisBuild = new Set()
    const config = {
      ...(portable && { extraFiles: base.extraFiles }),
      forceCodeSigning: true,
      win: {
        ...(portable && { artifactName: base.win.artifactName }),
        signtoolOptions: {
          sign(task) {
            sign(task)
            signedThisBuild.add(path.resolve(task.path))
          },
          publisherName: [publisher],
          signingHashAlgorithms: ['sha256']
        }
      }
    }

    if (pkg.scripts.build) {
      if (!process.env.npm_execpath) throw new Error('Run npm run dist:win-release to build this app.')
      run(process.execPath, [process.env.npm_execpath, 'run', 'build'])
    }
    const { Arch, Platform, build } = require('electron-builder')
    await build({
      projectDir: root,
      config,
      targets: Platform.WINDOWS.createTarget(portable ? 'zip' : 'nsis', Arch.x64),
      publish: args.includes('--publish') ? 'always' : 'never'
    })

    if (!signedThisBuild.has(app)) throw new Error('Packaged app was not signed during this build.')
    verifyArtifact(app, tools)
    if (portable) {
      run(process.execPath, [path.join(__dirname, 'portable-feed.mjs'), out])
      return
    }
    if (!signedThisBuild.has(installer)) throw new Error('Installer was not signed during this build.')
    verifyArtifact(installer, tools)
    await verifyUpdateFeed(out, pkg.version, installerName, createRequire(require.resolve('electron-builder')))
    console.log('Verified the Windows release installer, publisher, timestamp and updater checksum.')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
