#!/usr/bin/env python3
"""Genuine rootless cross-architecture APK transaction; NEVER run package scripts on host.
Normal builds consume exact hashes/versions from the reviewed lock, not a rolling index.
"""
import hashlib
import json
import pathlib
import platform
import re
import subprocess
import sys
import tarfile


def fetch(url, dest, digest):
    dest = pathlib.Path(dest)
    if not dest.exists():
        tmp = dest.with_suffix(dest.suffix + '.part')
        subprocess.run(['curl', '-fLsS', '--retry', '2', url, '-o', str(tmp)], check=True)
        tmp.replace(dest)
    if hashlib.sha256(dest.read_bytes()).hexdigest() != digest:
        raise ValueError(f'SHA256 mismatch: {dest.name}')


def check_elf(header, bits, machine, name):
    if header[:6] != b'\x7fELF' + bytes((bits, 1)) or header[18:20] != machine.to_bytes(2, 'little'):
        raise ValueError(f'Wrong ELF architecture: {name}')


def host_apk(lock, cache):
    arch = platform.machine()
    if arch not in ('aarch64', 'x86_64'):
        raise ValueError(f'No pinned native apk-tools-static for host {arch}')
    tool = lock['host_tools'][arch]
    directory = pathlib.Path(cache) / ('host-' + arch)
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / ('apk-tools-static-' + tool['version'] + '.apk')
    fetch(tool['url'], archive, tool['sha256'])
    # Extract exactly one regular file as bytes, never tar.extract() or package metadata/scripts.
    with tarfile.open(archive, 'r:gz', ignore_zeros=True) as tar:
        member = tar.getmember('sbin/apk.static')
        if not member.isfile():
            raise ValueError('apk.static must be a regular file')
        binary = tar.extractfile(member).read()
    if hashlib.sha256(binary).hexdigest() != tool['binary_sha256']:
        raise ValueError('apk.static binary SHA256 mismatch')
    check_elf(binary[:20], 2, 183 if arch == 'aarch64' else 62, 'apk.static')
    executable = directory / 'apk.static'
    executable.write_bytes(binary)
    executable.chmod(0o755)
    return executable.resolve()


def apk_command(apk, root, *args):
    # Flags apply to EVERY mutation, including world cleanup. Official package signatures
    # are checked with the existing keys from the pinned minirootfs. No allow-untrusted.
    return [str(apk), '--root', str(root), '--arch', 'x86', '--no-network', '--no-scripts', *args]


def installed(root):
    # Read-only audit of APK's own output; all database writes belong to apk.static.
    records = {}
    for block in (root / 'lib/apk/db/installed').read_text().split('\n\n'):
        fields = dict(line.split(':', 1) for line in block.splitlines() if line.startswith(('P:', 'V:')))
        if 'P' in fields:
            records[fields['P']] = fields['V']
    return records


def install(lock, cache, root):
    if lock.get('architecture') != 'x86' or lock.get('format') != 1:
        raise ValueError('Expected format 1 x86 package lock')
    root = pathlib.Path(root).resolve()
    cache = pathlib.Path(cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    before = installed(root)
    world = (root / 'etc/apk/world').read_text().splitlines()
    base_world = {re.split('[<>=~@]', item)[0] for item in world}
    archives = []
    for pkg in lock['packages']:
        if pkg['arch'] not in ('x86', 'noarch'):
            raise ValueError('Wrong package architecture')
        archive = cache / (pkg['name'] + '-' + pkg['version'] + '.apk')
        fetch(pkg['url'], archive, pkg['sha256'])
        archives.append(str(archive))
    apk = host_apk(lock, cache)
    subprocess.run(apk_command(apk, root, 'add', *archives), check=True)
    # Local-file add temporarily checksum-pins every artifact in world. Use real APK
    # transactions to leave only original world + requested tools, without pinning all
    # dependencies forever. Installed dependencies remain required by those roots.
    dependencies = [pkg['name'] for pkg in lock['packages']
                    if pkg['name'] not in base_world and pkg['name'] not in lock['requested']]
    if dependencies:
        subprocess.run(apk_command(apk, root, 'del', *dependencies), check=True)
    subprocess.run(apk_command(apk, root, 'add', *lock['requested']), check=True)
    after = installed(root)
    if before.keys() - after.keys():
        raise ValueError('APK transaction removed original base packages')
    for pkg in lock['packages']:
        if after.get(pkg['name']) != pkg['version']:
            raise ValueError(f'Installed version differs from lock: {pkg["name"]}')
    for name, version in before.items():
        if name not in {pkg['name'] for pkg in lock['packages']} and after[name] != version:
            raise ValueError(f'Unexpected base package version change: {name}')
    ca = root / 'etc/ssl/certs/ca-certificates.crt'
    if b'-----BEGIN CERTIFICATE-----' not in ca.read_bytes():
        raise ValueError('Missing pre-generated Mozilla CA bundle')
    count = 0
    for file in root.rglob('*'):
        if file.is_symlink() or not file.is_file():
            continue
        with file.open('rb') as stream:
            header = stream.read(20)
        if header[:4] == b'\x7fELF':
            check_elf(header, 1, 3, file)
            count += 1
    (root / 'etc/alpine-toolset.json').write_text(json.dumps(lock, indent=2) + '\n')
    print(f'APK installed {len(lock["packages"])} locked packages; '
          f'{len(after)} total records; checked {count} x86 ELF objects', flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[1] != 'install':
        sys.exit('usage: alpine-toolset.py install LOCK CACHE ROOTFS')
    install(json.loads(pathlib.Path(sys.argv[2]).read_text()), sys.argv[3], sys.argv[4])
