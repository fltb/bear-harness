#!/usr/bin/env python3
"""Build the nine approved slides from individually measured narration sentences."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import subprocess
import tempfile
import wave
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.local-output'
CACHE = OUT / 'narration-clips'
VOICE = 'zh-CN-YunxiNeural'
RATE = '+0%'
HZ = 48000
SLIDE_FOR = {0: 1, 1: 2, 2: 2, 3: 3, 4: 4, 5: 4, 6: 5, 7: 5, 8: 6, 9: 7, 10: 7, 11: 8, 12: 9}


def sentences(text):
    return [part.strip() for part in re.split(r'(?<=[。！？])', text) if part.strip()]


def duration(path):
    with wave.open(str(path), 'rb') as wav:
        return wav.getnframes() / wav.getframerate()


async def prepare_voice(slides):
    CACHE.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(4)
    clips = {}

    async def prepare(slide, index, text):
        digest = hashlib.sha256(f'{VOICE}|{RATE}|{text}'.encode()).hexdigest()
        target = CACHE / f'{digest}.wav'
        async with semaphore:
            if not target.exists():
                mp3 = CACHE / f'{digest}.mp3'
                for attempt in range(3):
                    try:
                        await asyncio.wait_for(edge_tts.Communicate(text, VOICE, rate=RATE).save(str(mp3)), timeout=40)
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(2 * (attempt + 1))
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(mp3), '-ar', str(HZ), '-ac', '2', '-c:a', 'pcm_s16le', str(target)], check=True)
                mp3.unlink()
            clips[(slide, index)] = {'path': target, 'duration': duration(target), 'text': text}
            print(f'voice {slide}.{index + 1} ready', flush=True)

    await asyncio.gather(*(prepare(slide['id'], index, text) for slide in slides for index, text in enumerate(sentences(slide['narration']))))
    return clips


def schedule(scenes, slides, clips):
    rows, cues = [], []
    now = 0.0

    def begin(scene_id):
        nonlocal now
        row = {'id': scene_id, 'slideId': SLIDE_FOR[scene_id], 'start': now, 'inputStart': now, 'responseStart': now, 'responseEnd': now}
        rows.append(row)
        return row

    def say(row, index):
        nonlocal now
        key = (row['slideId'], index)
        clip = clips[key]
        start = now
        cues.append({'slideId': key[0], 'sentence': index + 1, 'sceneId': row['id'], 'start': start, 'end': start + clip['duration'], 'text': clip['text'], 'path': str(clip['path'])})
        now += clip['duration'] + 0.35
        return start

    def dialogue(row, start):
        scene = scenes[row['id']]
        row['inputStart'] = start
        row['responseStart'] = start + max(0.6, len(scene['user']) * 0.07)
        row['responseEnd'] = row['responseStart'] + max(0.8, len(scene['assistant']) * 0.075)
        return row['responseEnd']

    def hold_reply(row, seconds=5):
        nonlocal now
        now = max(now, row['responseEnd']) + seconds

    def finish(row, navigation=False):
        nonlocal now
        row.setdefault('actionStart', now)
        if navigation:
            row['exitAt'] = now
            now += 1.2
        row['end'] = now
        own = [cue for cue in cues if cue['sceneId'] == row['id']]
        row['narrationStart'] = own[0]['start'] if own else None
        row['narrationEnd'] = own[-1]['end'] if own else None
        row['narrationDuration'] = sum(cue['end'] - cue['start'] for cue in own)
        row['readingSeconds'] = max(0, row['end'] - row['responseEnd'])
        for key, value in list(row.items()):
            if isinstance(value, float):
                row[key] = round(value, 3)

    # Slide 1: introduce the software immediately, before any scripted message.
    row = begin(0)
    now += 0.4
    for index in range(6):
        say(row, index)
    now += 0.8
    finish(row)

    # Slide 2: explain sending, demonstrate it, then leave the second reply alone.
    row = begin(1)
    say(row, 0)
    say(row, 1)
    dialogue(row, say(row, 2))
    hold_reply(row, 4)
    say(row, 3)
    finish(row)
    row = begin(2)
    dialogue(row, now + 0.4)
    hold_reply(row, 7)
    finish(row)

    # Slide 3: the thumbnail opens exactly at the sentence about enlarging it.
    row = begin(3)
    say(row, 0)
    say(row, 1)
    dialogue(row, say(row, 2))
    hold_reply(row, 4)
    row['actionStart'] = now
    say(row, 3)
    say(row, 4)
    say(row, 5)
    now += 1.0
    row['closeAt'] = now
    now += 1.0
    finish(row, navigation=True)

    # Slide 4: actually switch characters, keeping each native conversation intact.
    row = begin(4)
    say(row, 0)
    say(row, 1)
    dialogue(row, say(row, 2))
    hold_reply(row, 6)
    say(row, 3)
    finish(row, navigation=True)
    row = begin(5)
    say(row, 4)
    dialogue(row, now + 0.3)
    hold_reply(row, 6)
    say(row, 5)
    finish(row, navigation=True)

    # Slide 5: return, save, then open the actual memory panel while describing it.
    row = begin(6)
    say(row, 0)
    finish(row)
    row = begin(7)
    say(row, 1)
    dialogue(row, say(row, 2))
    hold_reply(row, 5)
    row['actionStart'] = now
    say(row, 3)
    say(row, 4)
    now += 2.0
    finish(row)

    # Slide 6: a genuine new conversation, followed by explanation of its reply.
    row = begin(8)
    say(row, 0)
    say(row, 1)
    dialogue(row, say(row, 2))
    hold_reply(row, 6)
    for index in (3, 4, 5):
        say(row, index)
    finish(row)

    # Slide 7: submit work, switch while it runs, and retain the chair callback.
    row = begin(9)
    say(row, 0)
    dialogue(row, say(row, 1))
    hold_reply(row, 3)
    say(row, 2)
    finish(row)
    row = begin(10)
    say(row, 3)
    say(row, 4)
    dialogue(row, now + 0.3)
    hold_reply(row, 6)
    row['actionStart'] = now
    now += 2.0
    finish(row)

    # Slide 8: open, inspect, then download at the matching spoken sentence.
    row = begin(11)
    say(row, 0)
    say(row, 1)
    now += 5.0
    say(row, 2)
    say(row, 3)
    now += 2.0
    row['actionStart'] = now
    say(row, 4)
    say(row, 5)
    now += 2.0
    finish(row)

    row = begin(12)
    now += 0.6
    for index in range(6):
        say(row, index)
    now += 3.0
    finish(row)

    for slide in slides:
        actual = ''.join(cue['text'] for cue in cues if cue['slideId'] == slide['id'])
        if actual != slide['narration']:
            raise RuntimeError(f"Slide {slide['id']} narration differs from the approved copy")
    for previous, following in zip(cues, cues[1:]):
        if previous['end'] > following['start']:
            raise RuntimeError('Narration sentences overlap')
    return rows, cues, round(now, 3)


def mix(cues, total, path):
    cursor = 0
    with wave.open(str(path), 'wb') as output:
        output.setparams((2, 2, HZ, 0, 'NONE', 'not compressed'))
        for cue in cues:
            start = round(cue['start'] * HZ)
            if start < cursor:
                raise RuntimeError('Audio samples overlap')
            output.writeframesraw(b'\0' * ((start - cursor) * 4))
            with wave.open(cue['path'], 'rb') as clip:
                frames = clip.getnframes()
                output.writeframesraw(clip.readframes(frames))
            cursor = start + frames
        output.writeframesraw(b'\0' * ((round(total * HZ) - cursor) * 4))


def timestamp(value):
    millis = round(value * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{millis:03}'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    slides = json.loads((ROOT / 'src/demo/slides.json').read_text())
    scenes = {scene['id']: scene for scene in json.loads((ROOT / 'src/demo/scenario.json').read_text())}
    clips = asyncio.run(prepare_voice(slides))
    rows, cues, total = schedule(scenes, slides, clips)
    captions = [{key: value for key, value in cue.items() if key != 'path'} for cue in cues]
    srt = '\n'.join(f"{i}\n{timestamp(c['start'])} --> {timestamp(c['end'])}\n{c['text']}\n" for i, c in enumerate(captions, 1)) + '\n'
    timeline = {'duration': total, 'scenes': rows, 'captions': captions, 'audio': 'narration.wav', 'sourceNarration': 'src/demo/slides.json', 'voice': {'voice': VOICE, 'rate': RATE, 'characterVoice': False}, 'slides': [{'id': slide['id'], 'title': slide['title'], 'start': min(row['start'] for row in rows if row['slideId'] == slide['id']), 'end': max(row['end'] for row in rows if row['slideId'] == slide['id'])} for slide in slides]}
    with tempfile.TemporaryDirectory(prefix='.narration-stage-', dir=OUT) as temporary:
        stage = Path(temporary)
        mix(cues, total, stage / 'narration.wav')
        (stage / 'captions.srt').write_text(srt)
        (stage / 'captions.vtt').write_text('WEBVTT\n\n' + re.sub(r'(\d{2}:\d{2}:\d{2}),(\d{3})', r'\1.\2', srt))
        (stage / 'timeline.json').write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + '\n')
        (stage / 'narration-segments.json').write_text(json.dumps(captions, ensure_ascii=False, indent=2) + '\n')
        generation = {'source': 'src/demo/slides.json', 'sentences': len(cues), 'duration': total, 'voice': VOICE, 'rate': RATE, 'subtitlePolicy': 'One current sentence only; measured independent audio clips; no estimated character-weight timing.', 'humanListeningReview': False}
        (stage / 'generation.json').write_text(json.dumps(generation, ensure_ascii=False, indent=2) + '\n')
        for file in stage.iterdir():
            file.replace(OUT / file.name)
    print(f'Generated nine slides, {len(cues)} timed sentences, {total:.3f}s', flush=True)


if __name__ == '__main__':
    main()
