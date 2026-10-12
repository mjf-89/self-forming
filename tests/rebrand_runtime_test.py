import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('runtime_rebranding', Path(__file__).resolve().parents[1] / 'scripts/rebrand-runtime.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
BRAND = 'prior-brand'
OLD_PATH = f'/nonexistent/{BRAND}-loader/loader'.encode()
NEW_PATH = b'/nonexistent/selfforming-loader/loader'


class RuntimeRebrandingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='self-forming-rebrand-test-')
        self.addCleanup(self.temporary.cleanup)
        self.runtime = Path(self.temporary.name) / 'runtime'

    def fixture(self, changes=None, native=None):
        files = {
            f'usr/share/{BRAND}/packages.txt': b'package\t1.0\tarm64\n',
            f'usr/share/{BRAND}/package-licenses.txt': f'/usr/share/{BRAND}/licenses/example.txt\n'.encode(),
            f'usr/share/{BRAND}/licenses/example.txt': b'Unmodified component license\n',
            f'etc/apt/apt.conf.d/99{BRAND}': b'APT::Sandbox::User "root";\n',
            'usr/local/bin/pi-android': b'#!/bin/sh\necho pi-android\n',
            'usr/bin/fixture': b'\x7fELF\x00unchanged machine code\x01'
        }
        files.update(changes or {})
        entries = [{'path': f'usr/share/{BRAND}', 'kind': 'directory', 'mode': 0o755},
                   {'path': 'usr/share/current-license', 'kind': 'symlink', 'target': f'/usr/share/{BRAND}/licenses/example.txt'},
                   {'path': 'usr/share/license-copy', 'kind': 'hardlink', 'target': f'usr/share/{BRAND}/licenses/example.txt'}]
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zipped:
            for name, data in files.items():
                zipped.writestr(name, data)
                entries.append({'path': name, 'kind': 'file', 'mode': 0o644, 'bytes': len(data)})
        archive = out.getvalue()
        manifest = {'schema': 1, 'distro': 'ubuntu', 'release': '24.04', 'abi': 'arm64-v8a',
                    'sha256': hashlib.sha256(archive).hexdigest(), 'compressedBytes': len(archive),
                    'expandedBytes': sum(len(data) for data in files.values()), 'entries': entries}
        payload = {'assets/runtime/ubuntu-arm64-v8a.zip': archive,
                   'assets/runtime/ubuntu-arm64-v8a.json': json.dumps(manifest).encode(),
                   'jniLibs/arm64-v8a/libproot.so': native if native is not None else b'\x7fELF\x01\x00' + OLD_PATH + b'\x00tail\x00',
                   'jniLibs/arm64-v8a/libproot-loader.so': b'\x7fELF\x00unchanged loader',
                   'assets/licenses/proot.txt': b'Unmodified PRoot license'}
        for name, data in payload.items():
            path = self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return payload

    def snapshot(self):
        return {path.relative_to(self.runtime).as_posix(): path.read_bytes() for path in self.runtime.rglob('*') if path.is_file()}

    def test_audited_paths_binary_and_manifest_remain_consistent(self):
        original = self.fixture()
        report = MODULE.rebrand(self.runtime, BRAND)
        self.assertEqual(report['legacyBrandScan'], 'passed')
        self.assertEqual(report['prootFallbackPatches'], 1)
        self.assertIn('usr/share/self-forming/package-licenses.txt', report['rewrittenMetadata'])
        binary = (self.runtime / 'jniLibs/arm64-v8a/libproot.so').read_bytes()
        self.assertEqual(binary, original['jniLibs/arm64-v8a/libproot.so'].replace(OLD_PATH, NEW_PATH))
        self.assertEqual(len(binary), len(original['jniLibs/arm64-v8a/libproot.so']))
        self.assertEqual((self.runtime / 'assets/licenses/proot.txt').read_bytes(), original['assets/licenses/proot.txt'])
        manifest = json.loads((self.runtime / 'assets/runtime/ubuntu-arm64-v8a.json').read_text())
        archive = self.runtime / 'assets/runtime/ubuntu-arm64-v8a.zip'
        MODULE.validate_rootfs(archive, manifest)
        self.assertEqual(manifest['sha256'], report['rootfsSha256'])
        links = {item['path']: item['target'] for item in manifest['entries'] if item['kind'] in ('symlink', 'hardlink')}
        self.assertEqual(links['usr/share/current-license'], '/usr/share/self-forming/licenses/example.txt')
        self.assertEqual(links['usr/share/license-copy'], 'usr/share/self-forming/licenses/example.txt')
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.read('usr/share/self-forming/package-licenses.txt'), b'/usr/share/self-forming/licenses/example.txt\n')
            self.assertIn('etc/apt/apt.conf.d/99self-forming', zipped.namelist())
            self.assertEqual(zipped.read('usr/local/bin/pi-android'), b'#!/bin/sh\necho pi-android\n')
            self.assertEqual(zipped.read('usr/bin/fixture'), b'\x7fELF\x00unchanged machine code\x01')
            self.assertFalse(any(MODULE.legacy_pattern(BRAND).search(zipped.read(name)) for name in zipped.namelist()))
        self.assertFalse(any(MODULE.legacy_pattern(BRAND).search(value) for name, value in self.snapshot().items() if not name.endswith('.zip')))

    def test_unhandled_rootfs_brand_aborts_without_modifying_original(self):
        self.fixture({'usr/bin/fixture': b'\x7fELF\x00' + BRAND.encode() + b'\x00'})
        original = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'Unhandled brand in rootfs content'):
            MODULE.rebrand(self.runtime, BRAND)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(list(self.runtime.parent.glob('.runtime-rebrand-*')), [])

    def test_fallback_patch_refuses_embedded_nonisolated_string_and_other_binary_brands(self):
        for binary in (b'\x7fELFprefix' + OLD_PATH + b'\x00',
                       b'\x7fELF\x00' + OLD_PATH + b'/unexpected\x00',
                       b'\x7fELF\x00' + OLD_PATH + b'\x00' + BRAND.encode() + b'\x00'):
            with self.subTest(binary=binary):
                self.fixture(native=binary)
                original = self.snapshot()
                with self.assertRaises(ValueError):
                    MODULE.rebrand(self.runtime, BRAND)
                self.assertEqual(self.snapshot(), original)
        with self.assertRaisesRegex(ValueError, 'same byte length'):
            MODULE.patch_proot(b'\x00/nonexistent/short-loader/loader\x00', 'short', 'self-forming')

    def test_manifest_mismatch_and_rename_collision_are_rejected(self):
        self.fixture()
        manifest_path = self.runtime / 'assets/runtime/ubuntu-arm64-v8a.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['entries'][-1]['bytes'] += 1
        manifest_path.write_text(json.dumps(manifest))
        original = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'size mismatch'):
            MODULE.rebrand(self.runtime, BRAND)
        self.assertEqual(self.snapshot(), original)
        self.fixture({'usr/share/self-forming/packages.txt': b'destination already exists'})
        with self.assertRaisesRegex(ValueError, 'collides'):
            MODULE.rebrand(self.runtime, BRAND)

    def test_unrecognized_license_text_is_not_rewritten(self):
        self.fixture()
        license_path = self.runtime / 'assets/licenses/proot.txt'
        license_path.write_bytes(b'Copyright ' + BRAND.encode() + b' contributors')
        original = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'binary/license'):
            MODULE.rebrand(self.runtime, BRAND)
        self.assertEqual(self.snapshot(), original)


if __name__ == '__main__':
    unittest.main()
