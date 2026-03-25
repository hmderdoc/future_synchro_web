#!/sbbs/webv4_custom/.venv-whisper/bin/python3
"""generate-lyrics.py - Generate .lrc lyric files from MP3s using Whisper.

Scans the radio MP3 directory for files without companion .lrc files,
then runs OpenAI Whisper (local, offline) to transcribe them with timestamps.

Usage:
    python3 generate-lyrics.py [--mp3-dir /path/to/mp3s] [--model tiny] [--force]

Requirements:
    pip install openai-whisper

The generated .lrc files are placed alongside the source .mp3 files so
the web radio's visualizer.js can fetch them via the same radio-stream URL.

This script is designed to be run manually or via cron. It skips files that
already have an .lrc unless --force is given.
"""
import argparse
import glob
import os
import sys
import time


def find_mp3_dir():
    """Auto-detect the Synchronet file directory for originalcontent_mp3s."""
    candidates = [
        '/sbbs/files/originalcontent_mp3s',
        '/sbbs/data/files/originalcontent_mp3s',
        '/sbbs/data/dirs/mp3s',
    ]
    # Also scan /sbbs/files/ for directories containing 'mp3' or 'original'
    for base in ['/sbbs/files', '/sbbs/data/files']:
        if os.path.isdir(base):
            for d in os.listdir(base):
                dl = d.lower()
                if 'mp3' in dl or 'original' in dl:
                    candidates.append(os.path.join(base, d))

    for c in candidates:
        if os.path.isdir(c):
            return c
    return None


def generate_lrc(segments, title=''):
    """Convert Whisper segments to LRC format."""
    lines = []
    if title:
        lines.append('[ti:{}]'.format(title))
    lines.append('[re:generate-lyrics.py (Whisper)]')
    lines.append('')

    for seg in segments:
        start = seg['start']
        mins = int(start // 60)
        secs = start % 60
        text = seg['text'].strip()
        if text:
            lines.append('[{:02d}:{:05.2f}]{}'.format(mins, secs, text))

    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description='Generate .lrc lyrics from MP3s using Whisper')
    parser.add_argument('--mp3-dir', help='Path to MP3 directory (auto-detected if omitted)')
    parser.add_argument('--model', default='small', help='Whisper model: tiny, base, small, medium, large (default: small)')
    parser.add_argument('--force', action='store_true', help='Overwrite existing .lrc files')
    parser.add_argument('--language', default='en', help='Language hint (default: en)')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be done without doing it')
    args = parser.parse_args()

    mp3_dir = args.mp3_dir or find_mp3_dir()
    if not mp3_dir or not os.path.isdir(mp3_dir):
        print('ERROR: MP3 directory not found. Use --mp3-dir to specify.', file=sys.stderr)
        sys.exit(1)

    mp3_files = sorted(glob.glob(os.path.join(mp3_dir, '*.mp3')))
    if not mp3_files:
        print('No .mp3 files found in', mp3_dir)
        return

    # Find files needing lyrics
    todo = []
    for mp3 in mp3_files:
        lrc = mp3.rsplit('.', 1)[0] + '.lrc'
        if os.path.exists(lrc) and not args.force:
            continue
        todo.append((mp3, lrc))

    if not todo:
        print('All {} MP3 files already have .lrc lyrics. Use --force to regenerate.'.format(len(mp3_files)))
        return

    print('Found {} MP3 files, {} need lyrics'.format(len(mp3_files), len(todo)))

    if args.dry_run:
        for mp3, lrc in todo:
            print('  Would process:', os.path.basename(mp3))
        return

    # Import Whisper (deferred so --help and --dry-run work without it)
    try:
        import whisper
    except ImportError:
        print('ERROR: openai-whisper not installed. Run: pip install openai-whisper', file=sys.stderr)
        sys.exit(1)

    print('Loading Whisper model "{}"...'.format(args.model))
    model = whisper.load_model(args.model)
    print('Model loaded.')

    for idx, (mp3, lrc) in enumerate(todo, 1):
        basename = os.path.basename(mp3)
        title = basename.rsplit('.', 1)[0]
        print('\n[{}/{}] Processing: {}'.format(idx, len(todo), basename))

        t0 = time.time()
        try:
            result = model.transcribe(
                mp3,
                language=args.language,
                task='transcribe',
                verbose=False,
                word_timestamps=False,
            )
        except Exception as e:
            print('  ERROR: {}'.format(e))
            continue

        elapsed = time.time() - t0
        segments = result.get('segments', [])
        print('  Transcribed {} segments in {:.1f}s'.format(len(segments), elapsed))

        if not segments:
            print('  WARNING: No segments detected (instrumental?)')
            # Write a minimal LRC so we don't re-process this file
            lrc_text = '[ti:{}]\n[re:generate-lyrics.py]\n[00:00.00](instrumental)\n'.format(title)
        else:
            lrc_text = generate_lrc(segments, title)

        with open(lrc, 'w', encoding='utf-8') as f:
            f.write(lrc_text)
        print('  Wrote:', os.path.basename(lrc))

    print('\nDone! Generated lyrics for {} file(s).'.format(len(todo)))


if __name__ == '__main__':
    main()
