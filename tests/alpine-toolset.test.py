"""Pinned rootless host APK-tool regressions: python3 tests/alpine-toolset.test.py."""
import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('toolset', pathlib.Path(__file__).resolve().parents[1] / 'scripts/alpine-toolset.py')
toolset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(toolset)


class HostApkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = pathlib.Path(self.tmp.name)

    def host_fixture(self, symlink=False):
        directory = self.cache / 'host-aarch64'
        directory.mkdir()
        archive = directory / 'apk-tools-static-fixture.apk'
        binary = b'\x7fELF\x02\x01' + bytes(12) + b'\xb7\x00' + b'fixture-never-executed'
        with tarfile.open(archive, 'w:gz') as tar:
            script = b'#!/bin/sh\nexit 99\n'
            info = tarfile.TarInfo('.post-install')
            info.size = len(script)
            tar.addfile(info, io.BytesIO(script))
            info = tarfile.TarInfo('sbin/apk.static')
            if symlink:
                info.type = tarfile.SYMTYPE
                info.linkname = '/escape'
                tar.addfile(info)
            else:
                info.size = len(binary)
                tar.addfile(info, io.BytesIO(binary))
        return dict(host_tools=dict(aarch64=dict(version='fixture', url='https://invalid.example/not-fetched',
                    sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                    binary_sha256=hashlib.sha256(binary).hexdigest())))

    def test_only_hash_checked_regular_binary_extracted(self):
        lock = self.host_fixture()
        with patch.object(toolset.platform, 'machine', return_value='aarch64'):
            binary = toolset.host_apk(lock, self.cache)
        self.assertTrue(binary.is_file())
        self.assertFalse((binary.parent / '.post-install').exists())
        self.assertFalse((binary.parent / 'sbin').exists())

    def test_archive_digest_before_extraction(self):
        lock = self.host_fixture()
        lock['host_tools']['aarch64']['sha256'] = '0' * 64
        with patch.object(toolset.platform, 'machine', return_value='aarch64'):
            with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                toolset.host_apk(lock, self.cache)
        self.assertFalse((self.cache / 'host-aarch64/apk.static').exists())

    def test_binary_digest_before_execution(self):
        lock = self.host_fixture()
        lock['host_tools']['aarch64']['binary_sha256'] = '0' * 64
        with patch.object(toolset.platform, 'machine', return_value='aarch64'):
            with self.assertRaisesRegex(ValueError, 'binary SHA256 mismatch'):
                toolset.host_apk(lock, self.cache)
        self.assertFalse((self.cache / 'host-aarch64/apk.static').exists())

    def test_tool_symlink_rejected(self):
        lock = self.host_fixture(symlink=True)
        with patch.object(toolset.platform, 'machine', return_value='aarch64'):
            with self.assertRaisesRegex(ValueError, 'regular file'):
                toolset.host_apk(lock, self.cache)

    def test_wrong_elf_arch(self):
        with self.assertRaisesRegex(ValueError, 'Wrong ELF architecture'):
            toolset.check_elf(b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00', 1, 3, 'guest')

    def test_all_host_transaction_commands_are_offline_and_scripts_disabled(self):
        for operation in ('add', 'del', 'fix'):
            command = toolset.apk_command('/cache/apk.static', '/isolated/root', operation, 'dummy')
            self.assertEqual(command[:5], ['/cache/apk.static', '--root', '/isolated/root', '--arch', 'x86'])
            self.assertIn('--no-network', command)
            self.assertIn('--no-scripts', command)
            self.assertNotIn('--allow-untrusted', command)
            self.assertNotIn('--force-overwrite', command)


if __name__ == '__main__':
    unittest.main()
