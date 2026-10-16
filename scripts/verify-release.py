"""Check the signed CI APK and downloads without displaying embedded key material."""
from pathlib import Path
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import zipfile

root = Path(__file__).resolve().parent.parent
os.chdir(root)
version = json.loads(Path('package.json').read_text())['version']
assert version == os.environ['PACKAGE_VERSION'] and re.fullmatch(r'\d+\.\d+\.\d+', version)
sdk = Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT']) / 'build-tools/36.0.0'
apk = Path('apps/android/app/build/outputs/apk/release/app-release.apk')
certificate = subprocess.check_output([str(sdk / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], text=True)
expected = Path('apps/android/signing-certificate.sha256').read_text().strip().lower()
assert re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-f]+)', certificate).group(1).lower() == expected, 'Signing identity changed'
manifest = subprocess.check_output([str(sdk / 'aapt'), 'dump', 'badging', str(apk)], text=True)
assert "name='md.incept.selfforming'" in manifest.splitlines()[0]
assert f"versionName='{version}'" in manifest.splitlines()[0]
version_code = re.search(r'^selfFormingVersionCode=(\d+)$', Path('apps/android/gradle.properties').read_text(), re.M).group(1)
assert f"versionCode='{version_code}'" in manifest.splitlines()[0]
assert "application-label:'Self Forming'" in manifest
assert "native-code: 'arm64-v8a'" in manifest
assert 'application-debuggable' not in manifest, 'Published APKs must not be debuggable'
subprocess.run([str(sdk / 'zipalign'), '-c', '-P', '16', '-v', '4', str(apk)], check=True, stdout=subprocess.DEVNULL)
with zipfile.ZipFile(apk) as archive:
    for name in ['assets/web/index.html', 'assets/runtime/ubuntu-arm64-v8a.zip',
                 'assets/runtime/ubuntu-arm64-v8a.json', 'lib/arm64-v8a/libproot.so', 'lib/arm64-v8a/libproot-loader.so']:
        assert name in archive.namelist(), f'Missing {name}'
    with zipfile.ZipFile(io.BytesIO(archive.read('assets/self-source/source.zip'))) as source:
        names = set(source.namelist())
        for name in ['package.json', 'apps/common/session.js', 'scripts/pack-source.sh',
                     'skills/self-rebuild/SKILL.md', '.signing/self-forming.p12', '.signing/password']:
            assert name in names, f'Missing rebuild source {name}'
        assert all('.git' not in Path(name).parts for name in names), 'Git metadata must not be shipped'
        assert source.read('.signing/self-forming.p12') == Path('.signing/self-forming.p12').read_bytes()
        assert json.loads(source.read('package.json'))['version'] == version
        assert f'selfFormingVersionCode={version_code}' in source.read('apps/android/gradle.properties').decode()
        assert 'applicationId = "md.incept.selfforming"' in source.read('apps/android/app/build.gradle.kts').decode()
out = Path('out')
out.mkdir(exist_ok=True)
shutil.copyfile(apk, out / f'self-forming-{version}-arm64.apk')
with tarfile.open(out / f'self-forming-browser-{version}.tar.gz', 'w:gz') as archive:
    archive.add('dist/browser', arcname=f'self-forming-browser-{version}')
(out / 'verification.txt').write_text('\n'.join([
    f'Self Forming {version}', f'Commit: {os.environ["GITHUB_SHA"]}',
    f'Package: md.incept.selfforming; versionCode: {version_code}', f'Signing certificate SHA-256: {expected}',
    'PASS: fast JavaScript tests, type checking, browser asset build, Android JVM tests',
    'PASS: APK signature, package/version, ARM64 payload, ZIP 16 KiB alignment, embedded rebuild source',
    'The app signing key is deliberately embedded for on-device self-rebuilding; anyone with the APK can extract it.',
    'NOT RUN: Android emulator, physical device, real-account login or live models.', '',
]) + Path('runtime-source.env').read_text(), encoding='utf-8')
(out / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
    for path in sorted(out.iterdir()) if path.is_file() and path.name != 'SHA256SUMS'))
print(f'Verified release {version}, versionCode {version_code}, certificate {expected}; downloads ready in out/')
