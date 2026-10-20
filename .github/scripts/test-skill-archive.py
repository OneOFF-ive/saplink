"""Offline source integrity and reproducibility regression checks."""
import base64
import copy
import hashlib
import io
import unittest
from unittest.mock import patch
import urllib.error
import warnings
import zipfile

from skill_archive import build, load_release


class SkillTests(unittest.TestCase):
    def setUp(self):
        self.files = {'SKILL.md': b'---\nname: saplink-manager\n---\nUsage',
                      'references/client-setup.md': b'Client setup',
                      'agents/openai.yaml': b'display_name: SapLink'}
        self.entries = []
        self.blobs = {}
        for name, data in self.files.items():
            sha = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            self.entries.append({'path': 'skills/saplink-manager/' + name, 'type': 'blob',
                                 'mode': '100644', 'size': len(data), 'sha': sha})
            self.blobs[sha] = {'encoding': 'base64', 'content': base64.b64encode(data).decode()}
    def api(self, path):
        if path == 'commits/v1.0.1':
            return {'sha': 'a' * 40, 'commit': {'tree': {'sha': 'b' * 40}}}
        if path.startswith('git/trees/'):
            return {'tree': copy.deepcopy(self.entries), 'truncated': False}
        if path.startswith('git/blobs/'):
            return self.blobs[path.split('/')[-1]]
        raise AssertionError(path)

    def test_zip_uses_release_tag_and_includes_skill_and_supporting_files(self):
        content, metadata = build(self.api, '1.0.1')
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            self.assertEqual(set(archive.namelist()), {'saplink-manager/' + name for name in self.files})
            for name, data in self.files.items():
                self.assertEqual(archive.read('saplink-manager/' + name), data)
        self.assertEqual(metadata['commit'], 'a' * 40)
        self.assertEqual(metadata['sha256'], hashlib.sha256(content).hexdigest())
        self.assertEqual(metadata['size'], len(content))

    def test_zip_is_reproducible_across_tree_order(self):
        first = build(self.api, '1.0.1')
        self.entries.reverse()
        self.assertEqual(build(self.api, '1.0.1'), first)

    def test_corrupted_source_blob_is_rejected(self):
        self.blobs[self.entries[0]['sha']]['content'] = base64.b64encode(b'corrupted').decode()
        with self.assertRaisesRegex(ValueError, 'blob verification'):
            build(self.api, '1.0.1')

    def test_missing_skill_and_unsafe_entries_are_rejected(self):
        for change in ('missing', 'symlink', 'traversal'):
            with self.subTest(change=change):
                saved = copy.deepcopy(self.entries)
                if change == 'missing':
                    self.entries = self.entries[1:]
                elif change == 'symlink':
                    self.entries[1]['mode'] = '120000'
                else:
                    self.entries[1]['path'] = 'skills/saplink-manager/../secret'
                try:
                    with self.assertRaises(ValueError):
                        build(self.api, '1.0.1')
                finally:
                    self.entries = saved


    def attachments(self):
        generated, _ = build(self.api, '1.0.1')
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(generated)) as source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
            for name in source.namelist():
                target.writestr(name, source.read(name))
        content = output.getvalue()
        filename = 'SapLink-1.0.1-skill.zip'
        checksum = (hashlib.sha256(content).hexdigest() + '  ' + filename + '\n').encode()
        bodies = {1: content, 2: checksum}
        release = {'tag_name': 'v1.0.1', 'assets': [
            {'id': i, 'name': name, 'state': 'uploaded', 'size': len(bodies[i]),
             'digest': 'sha256:' + hashlib.sha256(bodies[i]).hexdigest()}
            for i, name in ((1, filename), (2, filename + '.sha256'))]}
        return release, bodies

    def test_prefers_release_zip_and_accepts_different_zip_encoders(self):
        release, bodies = self.attachments()
        calls = []
        def request(url, binary=False):
            calls.append(url)
            return io.BytesIO(bodies[int(url.rsplit('/', 1)[-1])])
        content, metadata = load_release(self.api, release, request)
        self.assertEqual(content, bodies[1])
        self.assertEqual(metadata['sha256'], hashlib.sha256(bodies[1]).hexdigest())
        self.assertEqual(metadata['size'], len(content))
        self.assertEqual(len(calls), 2)

    def test_missing_either_attachment_generates_from_tag_without_partial_download(self):
        for keep in ([], [0], [1]):
            release, _ = self.attachments()
            release['assets'] = [release['assets'][i] for i in keep]
            content, _ = load_release(self.api, release, lambda *a, **k: self.fail('Do not download incomplete pairs'))
            self.assertEqual(content, build(self.api, '1.0.1')[0])

    def test_network_failure_generates_from_tag(self):
        release, _ = self.attachments()
        content, _ = load_release(self.api, release, lambda *a, **k: (_ for _ in ()).throw(urllib.error.URLError('offline')))
        self.assertEqual(content, build(self.api, '1.0.1')[0])

    def test_checksum_mismatch_fails_instead_of_generating(self):
        release, bodies = self.attachments()
        bodies[2] = b'0' * 64 + b'  SapLink-1.0.1-skill.zip\n'
        release['assets'][1].pop('digest')
        with self.assertRaisesRegex(ValueError, 'sidecar mismatch'):
            load_release(self.api, release, lambda url, **kw: io.BytesIO(bodies[int(url.rsplit('/', 1)[-1])]))

    def test_valid_hash_cannot_hide_files_from_a_different_source_tag(self):
        release, bodies = self.attachments()
        canonical, metadata = build(self.api, '1.0.1')
        with zipfile.ZipFile(io.BytesIO(canonical)) as z:
            changed = io.BytesIO()
            with zipfile.ZipFile(changed, 'w') as out:
                for name in z.namelist():
                    out.writestr(name, b'changed' if name.endswith('SKILL.md') else z.read(name))
        bodies[1] = changed.getvalue()
        bodies[2] = (hashlib.sha256(bodies[1]).hexdigest() + '  SapLink-1.0.1-skill.zip\n').encode()
        for asset in release['assets']:
            asset['size'] = len(bodies[asset['id']]); asset.pop('digest')
        with self.assertRaisesRegex(ValueError, 'differs from the release tag'):
            load_release(self.api, release, lambda url, **kw: io.BytesIO(bodies[int(url.rsplit('/', 1)[-1])]))

    def test_traversal_and_duplicate_zip_paths_are_rejected(self):
        from skill_archive import archive_files
        bad = io.BytesIO()
        with zipfile.ZipFile(bad, 'w') as z:
            z.writestr('saplink-manager/../secret', b'data')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            archive_files(bad.getvalue())
        duplicate = io.BytesIO()
        with warnings.catch_warnings(), zipfile.ZipFile(duplicate, 'w') as z:
            warnings.simplefilter('ignore', UserWarning)
            z.writestr('saplink-manager/SKILL.md', b'first')
            z.writestr('saplink-manager/SKILL.md', b'second')
        with self.assertRaisesRegex(ValueError, 'Invalid'):
            archive_files(duplicate.getvalue())


if __name__ == '__main__':
    unittest.main()
