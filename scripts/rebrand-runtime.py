#!/usr/bin/env python3
"""Rename inherited runtime metadata and one audited PRoot fallback string, without rebuilding executable code."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_path(name):
    require(isinstance(name, str) and name and not PurePosixPath(name).is_absolute()
            and '..' not in PurePosixPath(name).parts and '\\' not in name
            and not any(ord(char) < 32 for char in name), 'Unsafe runtime member path')


def legacy_pattern(brand):
    variants = {brand, brand.replace('-', ''), brand.replace('-', ' '), brand.replace('-', '_')}
    return re.compile(b'|'.join(re.escape(value.encode('ascii')) for value in sorted(variants)), re.IGNORECASE)


def validate_rootfs(archive, manifest):
    require(manifest.get('schema') == 1 and manifest.get('distro') == 'ubuntu'
            and manifest.get('release') == '24.04' and manifest.get('abi') == 'arm64-v8a', 'Unsupported rootfs manifest')
    require(sha256(archive) == manifest.get('sha256')
            and archive.stat().st_size == manifest.get('compressedBytes'), 'Rootfs archive checksum/size mismatch')
    entries = manifest.get('entries')
    require(isinstance(entries, list), 'Missing rootfs entries')
    names = set()
    files = {}
    for entry in entries:
        name = entry.get('path')
        safe_path(name)
        require(name not in names, 'Duplicate rootfs manifest path')
        names.add(name)
        require(entry.get('kind') in ('file', 'directory', 'symlink', 'hardlink'), 'Unsupported rootfs entry kind')
        if entry['kind'] == 'file':
            require(isinstance(entry.get('bytes'), int) and entry['bytes'] >= 0, 'Invalid rootfs file size')
            files[name] = entry
        elif entry['kind'] in ('symlink', 'hardlink'):
            require(isinstance(entry.get('target'), str), 'Missing rootfs link target')
    require(sum(entry['bytes'] for entry in files.values()) == manifest.get('expandedBytes'), 'Rootfs expanded size mismatch')
    with zipfile.ZipFile(archive) as zipped:
        members = zipped.infolist()
        require(len(members) == len(files) and {item.filename for item in members} == set(files), 'Rootfs ZIP/manifest membership mismatch')
        for item in members:
            require(not item.is_dir() and item.file_size == files[item.filename]['bytes'], 'Rootfs ZIP/manifest member size mismatch')
    return files


def patch_proot(data, from_brand, to_brand):
    old = f'/nonexistent/{from_brand}-loader/loader'.encode('ascii')
    new = f'/nonexistent/{to_brand.replace("-", "")}-loader/loader'.encode('ascii')
    require(len(old) == len(new), 'PRoot fallback replacement must have exactly the same byte length')
    # The whole path must be an isolated C string, not an executable instruction or part of another string.
    matches = list(re.finditer(rb'(?<![^\x00])' + re.escape(old) + rb'\x00', data))
    require(len(matches) == 1, 'Expected exactly one isolated PRoot fallback string')
    match = matches[0]
    result = data[:match.start()] + new + data[match.start() + len(old):]
    require(len(result) == len(data), 'PRoot binary size changed')
    return result


def rebrand(runtime, from_brand, to_brand='self-forming'):
    require(re.fullmatch(r'[a-z][a-z0-9-]{1,63}', from_brand) is not None, 'Invalid source brand')
    require(to_brand == 'self-forming', 'The supported target brand is self-forming')
    require(from_brand != to_brand, 'Source and target brands must differ')
    runtime = Path(runtime).absolute()
    require(runtime.is_dir() and not runtime.is_symlink(), 'Runtime must be a regular directory')
    runtime = runtime.resolve()
    pattern = legacy_pattern(from_brand)
    old_directory = f'usr/share/{from_brand}'
    new_directory = f'usr/share/{to_brand}'
    old_apt = f'etc/apt/apt.conf.d/99{from_brand}'
    new_apt = f'etc/apt/apt.conf.d/99{to_brand}'
    metadata = {f'{old_directory}/{name}' for name in (
        'packages.txt', 'package-sources.txt', 'package-licenses.txt', 'ubuntu.json', 'box64.json')}
    renamed, rewritten = [], []
    patched = 0

    def rename(name):
        if name == old_directory or name.startswith(old_directory + '/'):
            return new_directory + name[len(old_directory):]
        return new_apt if name == old_apt else name

    def rewrite_paths(text):
        # Only these two audited, complete filesystem paths may change inside textual metadata or link targets.
        for old, new in ((old_directory, new_directory), (old_apt, new_apt)):
            text = re.sub(r'(?<![A-Za-z0-9_.-])' + re.escape(old) + r'(?=/|$|[\s\"\'])', lambda _match: new, text)
        return text

    members = {}
    for path in runtime.rglob('*'):
        require(not path.is_symlink(), 'Runtime payload must not contain filesystem symlinks')
        if path.is_dir():
            continue
        require(path.is_file(), 'Runtime payload contains a non-regular file')
        name = path.relative_to(runtime).as_posix()
        allowed = (re.fullmatch(r'jniLibs/arm64-v8a/libproot[A-Za-z0-9._-]*\.so', name)
                   or name in ('assets/runtime/ubuntu-arm64-v8a.zip', 'assets/runtime/ubuntu-arm64-v8a.json')
                   or re.fullmatch(r'assets/licenses/[A-Za-z0-9][A-Za-z0-9._-]*', name))
        require(allowed, f'Unexpected runtime payload file: {name}')
        members[name] = path
    archive_name = 'assets/runtime/ubuntu-arm64-v8a.zip'
    manifest_name = 'assets/runtime/ubuntu-arm64-v8a.json'
    for name in (archive_name, manifest_name, 'jniLibs/arm64-v8a/libproot.so', 'jniLibs/arm64-v8a/libproot-loader.so'):
        require(name in members, f'Missing runtime file: {name}')
    manifest = json.loads(members[manifest_name].read_text(encoding='utf-8'))
    validate_rootfs(members[archive_name], manifest)
    output_manifest = copy.deepcopy(manifest)
    mapped = {}
    destinations = set()
    for entry in output_manifest['entries']:
        old = entry['path']
        new = rename(old)
        require(new not in destinations, 'Runtime metadata rename collides with an existing path')
        destinations.add(new)
        mapped[old] = new
        if old != new:
            renamed.append(f'{old} -> {new}')
        entry['path'] = new
        if entry['kind'] in ('symlink', 'hardlink'):
            entry['target'] = rewrite_paths(entry['target'])
            require(not pattern.search(entry['target'].encode('utf-8')), f'Unhandled brand in link target: {new}')
        require(not pattern.search(new.encode('utf-8')), f'Unhandled brand in rootfs path: {new}')
    output_files = {entry['path']: entry for entry in output_manifest['entries'] if entry['kind'] == 'file'}

    # Validate every transformed byte in staging before replacing the installed payload. On a failed swap,
    # restore the original directory. The temporary sibling contains only this operation's own data.
    with tempfile.TemporaryDirectory(prefix='.runtime-rebrand-', dir=runtime.parent) as temporary:
        stage_parent = Path(temporary).resolve()
        require(stage_parent.parent == runtime.parent, 'Unsafe staging directory')
        stage = stage_parent / 'payload'
        stage.mkdir()
        for name, path in members.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if name in (archive_name, manifest_name):
                continue
            data = path.read_bytes()
            if pattern.search(data):
                require(name == 'jniLibs/arm64-v8a/libproot.so', f'Unhandled brand in runtime binary/license: {name}')
                require(data.startswith(b'\x7fELF'), 'PRoot fallback patch requires an ELF binary')
                data = patch_proot(data, from_brand, to_brand)
                patched += 1
            require(not pattern.search(data) and not pattern.search(name.encode('utf-8')), f'Unhandled brand in runtime file: {name}')
            target.write_bytes(data)
            shutil.copymode(path, target)
        with zipfile.ZipFile(members[archive_name]) as source, zipfile.ZipFile(stage / archive_name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
            for item in sorted(source.infolist(), key=lambda item: mapped[item.filename]):
                data = source.read(item)  # Also checks each original ZIP member's CRC.
                name = mapped[item.filename]
                if item.filename in metadata:
                    text = data.decode('utf-8')
                    changed = rewrite_paths(text).encode('utf-8')
                    if changed != data:
                        rewritten.append(name)
                        data = changed
                require(not pattern.search(data), f'Unhandled brand in rootfs content: {name}')
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                target.writestr(info, data, compresslevel=9)
                output_files[name]['bytes'] = len(data)
        output_manifest['sha256'] = sha256(stage / archive_name)
        output_manifest['compressedBytes'] = (stage / archive_name).stat().st_size
        output_manifest['expandedBytes'] = sum(entry.get('bytes', 0) for entry in output_manifest['entries'])
        manifest_bytes = (json.dumps(output_manifest, separators=(',', ':')) + '\n').encode('utf-8')
        require(not pattern.search(manifest_bytes), 'Unhandled brand in manifest metadata')
        (stage / manifest_name).write_bytes(manifest_bytes)
        validate_rootfs(stage / archive_name, output_manifest)
        backup = stage_parent / 'original'
        os.replace(runtime, backup)
        try:
            os.replace(stage, runtime)
        except BaseException:
            os.replace(backup, runtime)
            raise
    report = {'renamed': renamed, 'rewrittenMetadata': rewritten, 'prootFallbackPatches': patched,
              'rootfsSha256': output_manifest['sha256'], 'compressedBytes': output_manifest['compressedBytes'],
              'expandedBytes': output_manifest['expandedBytes'], 'legacyBrandScan': 'passed'}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-brand', required=True)
    parser.add_argument('--to-brand', default='self-forming')
    parser.add_argument('--runtime', default='dist/runtime')
    args = parser.parse_args()
    try:
        print(json.dumps(rebrand(args.runtime, args.from_brand, args.to_brand), indent=2))
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, f'Runtime rebranding failed: {error}\n')
