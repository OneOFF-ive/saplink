"""The website skill job must not prepare or download installers."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

class PrepareSkillTests(unittest.TestCase):
    def test_skill_mode_needs_no_installer_assets(self):
        (Path(__file__).resolve().parents[2] / ".saplink/tests").mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / '.saplink/tests') as temporary, patch.dict(os.environ, {
            'RUNNER_TEMP': temporary, 'GITHUB_OUTPUT': str(Path(temporary) / 'output'),
            'SKILL_ONLY': '1', 'RELEASE_TAG': 'v1.2.3'
        }):
            spec = importlib.util.spec_from_file_location('prepare_skill', Path(__file__).with_name('prepare-website-release.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            release = {'tag_name': 'v1.2.3', 'published_at': '2026-10-20T00:00:00Z', 'assets': []}
            with patch.object(module, 'api', return_value=release), patch.object(module, 'request', side_effect=AssertionError('No binary requests')):
                module.main()
            self.assertEqual(Path(os.environ['GITHUB_OUTPUT']).read_text(), 'ready=true\nversion=1.2.3\n')
            self.assertEqual(list(module.ROOT.iterdir()), [])

if __name__ == '__main__':
    unittest.main()

