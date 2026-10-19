"""One-time root deployment alongside the existing restricted SSH receiver."""
import ast
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path('/usr/local/lib/saplink-release-sync')
BACKUPS = Path('/var/backups/saplink-release-sync')
HOOK = '''    # Dispatch bounded uploads; retain the original check/sync/status protocol.
    if os.environ.get('SSH_ORIGINAL_COMMAND', '').split(' ', 1)[0] in {'prepare', 'chunk', 'promote', 'skill'}:
        from website_upload_receiver import handle
        handle(os.environ['SSH_ORIGINAL_COMMAND'], sys.modules[__name__])
        return
'''


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run this deployment script as root')
    receiver = ROOT / 'receive_release.py'
    if receiver.is_symlink() or not receiver.is_file():
        raise SystemExit('Existing restricted receiver is required')
    source = receiver.read_text(encoding='utf-8-sig')
    helper = Path(__file__).with_name('website_upload_receiver.py').read_text(encoding='utf-8-sig')
    skill = Path(__file__).with_name('website_skill.py').read_text(encoding='utf-8-sig')
    if 'from website_upload_receiver import handle' in source:
        source = source.replace("{'prepare', 'chunk', 'promote'}", "{'prepare', 'chunk', 'promote', 'skill'}")
        if "{'prepare', 'chunk', 'promote', 'skill'}" not in source:
            raise SystemExit('Unknown receiver dispatch layout; review before deployment')
    if 'from website_upload_receiver import handle' not in source:
        if source.count('def main():\n') != 1:
            raise SystemExit('Unknown receiver layout; review before deployment')
        source = source.replace('def main():\n', 'def main():\n' + HOOK, 1)
    ast.parse(source)
    ast.parse(helper)
    ast.parse(skill)
    backup = BACKUPS / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True, mode=0o700)
    for name in ('receive_release.py', 'website_upload_receiver.py', 'website_skill.py'):
        target = ROOT / name
        if target.is_symlink():
            raise SystemExit('Receiver symlinks require administrator review')
        if target.exists():
            shutil.copy2(target, backup / name)
    for name, content in (('website_skill.py', skill), ('website_upload_receiver.py', helper), ('receive_release.py', source)):
        fd, temporary = tempfile.mkstemp(dir=ROOT, prefix='.deploy-')
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(content)
            os.chmod(temporary, 0o644)
            os.replace(temporary, ROOT / name)
        finally:
            Path(temporary).unlink(missing_ok=True)
    print('Resumable receiver deployed; backup: ' + str(backup))


if __name__ == '__main__':
    main()
