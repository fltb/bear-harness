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
SLIDE_FOR = {0: 1, 1: 2, 2: 2, 3: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 5, 9: 5, 10: 6, 11: 7, 12: 7, 13: 8, 14: 9}


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
        digest = hashlib.sha256(f'{VOICE}|{RATE}|WordBoundary|{text}'.encode()).hexdigest()
        target = CACHE / f'{digest}.wav'
        async with semaphore:
            metadata = CACHE / f'{digest}.jsonl'
            if not target.exists() or not metadata.exists():
                mp3 = CACHE / f'{digest}.mp3'
                for attempt in range(3):
                    try:
                        await asyncio.wait_for(edge_tts.Communicate(text, VOICE, rate=RATE, boundary='WordBoundary').save(str(mp3), str(metadata)), timeout=40)
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(2 * (attempt + 1))
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(mp3), '-ar', str(HZ), '-ac', '2', '-c:a', 'pcm_s16le', str(target)], check=True)
                mp3.unlink()
            clips[(slide, index)] = {'path': target, 'duration': duration(target), 'text': text, 'words': [json.loads(line) for line in metadata.read_text().splitlines()]}
            print(f'voice {slide}.{index + 1} ready', flush=True)

    await asyncio.gather(*(prepare(slide['id'], index, text) for slide in slides for index, text in enumerate(sentences(slide['narration']))))
    return clips


def schedule(scenes, slides, clips):
    rows, cues = [], []
    now = 0.0

    def narrate(slide, indices):
        nonlocal now
        section = {}
        for index in indices:
            clip = clips[(slide, index)]
            cue = {'slideId': slide, 'sentence': index + 1, 'start': now,
                   'end': now + clip['duration'], 'text': clip['text'], 'path': str(clip['path'])}
            cues.append(cue)
            section[index] = cue
            now = cue['end'] + 0.15
        return section

    def anchor(cue, phrase):
        # Service-provided word offsets, never character-weight audio estimates.
        words = clips[(cue['slideId'], cue['sentence'] - 1)]['words']
        normalize = lambda text: re.sub(r'[^\w]', '', text).casefold()
        spoken = ''.join(normalize(word['text']) for word in words)
        wanted = normalize(phrase)
        position = spoken.find(wanted)
        if position < 0:
            raise RuntimeError(f'Audio anchor missing: {phrase}')
        cursor = 0
        for word in words:
            cursor += len(normalize(word['text']))
            if cursor > position:
                return cue['start'] + word['offset'] / 10000000
        raise RuntimeError(f'Audio anchor has no timestamp: {phrase}')

    def row(scene_id, start, input_at=None, response_end=None):
        item = {'id': scene_id, 'slideId': SLIDE_FOR[scene_id], 'start': start,
                'inputStart': start, 'responseStart': start, 'responseEnd': start}
        if scenes[scene_id]['user']:
            item['inputStart'] = start if input_at is None else input_at
            item['responseStart'] = item['inputStart'] + min(1.8, max(0.55, len(scenes[scene_id]['user']) * 0.035))
            item['responseEnd'] = (response_end if response_end is not None else
                                   item['responseStart'] + min(2.4, max(0.8, len(scenes[scene_id]['assistant']) * 0.035)))
            if item['responseEnd'] <= item['responseStart']:
                raise RuntimeError(f'Scene {scene_id} has insufficient response time')
        rows.append(item)
        return item

    def finish(item, end=None, navigation=False):
        nonlocal now
        end = now if end is None else end
        if scenes[item['id']]['user']:
            end = max(end, item['responseEnd'] + 1.25)
        item['end'] = end
        item.setdefault('actionStart', end)
        # Navigation happens at the following scene's entry, alongside its narration.
        if navigation:
            item['exitAt'] = end
        now = max(now, end)
        return end

    start = now
    narrate(1, range(4))
    finish(row(0, start))

    start = now
    c = narrate(2, (0, 1, 2))
    first = row(1, start, anchor(c[1], '我们问极昼'), c[2]['start'])
    first['syncAnchors'] = {'sendIntroduction': first['inputStart'], 'replyExplanation': c[2]['start']}
    finish(first)
    start = now
    c = narrate(2, (3,))
    finish(row(2, start, anchor(c[3], '接着问一句')))

    start = now
    c = narrate(3, range(3))
    finish(row(3, start, c[0]['start'], c[1]['start']), navigation=True)

    start = now
    c = narrate(4, (0, 1, 2))
    first = row(4, start, c[1]['start'], c[2]['start'])
    followup = max(first['responseEnd'] + 1.25, anchor(c[2], '合适'))
    finish(first, followup)
    finish(row(5, followup), navigation=True)
    start = now
    c = narrate(4, (3, 4))
    first = row(6, start)
    followup = max(first['responseEnd'] + 1.25, c[4]['start'])
    finish(first, followup)
    finish(row(7, followup), navigation=True)

    start = now
    finish(row(8, start), start)
    c = narrate(5, range(3))
    memory = row(9, start, anchor(c[0], '我们请他记住'))
    memory['actionStart'] = anchor(c[1], '打开设置')
    if memory['responseEnd'] > memory['actionStart']:
        raise RuntimeError('Memory panel would open before the save completes')
    memory['syncAnchors'] = {'openMemory': memory['actionStart']}
    finish(memory)

    start = now
    c = narrate(6, range(3))
    finish(row(10, start, anchor(c[0], '问极昼'), c[1]['start']))

    start = now
    c = narrate(7, (0, 1))
    finish(row(11, start, anchor(c[0], '我们请极昼')))
    start = now
    c = narrate(7, (2,))
    background = row(12, start, anchor(c[2], '继续聊天'))
    background['actionStart'] = max(c[2]['end'], background['responseEnd'])
    background['syncAnchors'] = {'switchConversation': start}
    finish(background)

    start = now
    c = narrate(8, range(3))
    result = row(13, start)
    result['resultOpenAt'] = anchor(c[0], '点击')
    result['actionStart'] = anchor(c[1], '再点击')
    result['syncAnchors'] = {'openResult': result['resultOpenAt'], 'saveCopy': result['actionStart']}
    finish(result)

    start = now
    narrate(9, range(3))
    now += 0.8
    finish(row(14, start))

    for cue in cues:
        owner = next(item for item in rows if item['start'] <= cue['start'] < item['end'])
        cue['sceneId'] = owner['id']
    for item in rows:
        own = [cue for cue in cues if cue['start'] < item['end'] and cue['end'] > item['start']]
        item['narrationStart'] = max(item['start'], own[0]['start']) if own else None
        item['narrationEnd'] = min(item['end'], own[-1]['end']) if own else None
        item['narrationDuration'] = sum(max(0, min(item['end'], c['end']) - max(item['start'], c['start'])) for c in own)
        item['readingSeconds'] = max(0, item['end'] - item['responseEnd'])
        for key, value in list(item.items()):
            if isinstance(value, float):
                item[key] = round(value, 3)
    for slide in slides:
        actual = ''.join(cue['text'] for cue in cues if cue['slideId'] == slide['id'])
        if actual != slide['narration']:
            raise RuntimeError(f"Slide {slide['id']} narration differs from the approved copy")
    for previous, following in zip(cues, cues[1:]):
        if previous['end'] > following['start']:
            raise RuntimeError('Narration sentences overlap')
    for previous, following in zip(rows, rows[1:]):
        if previous['end'] != following['start']:
            raise RuntimeError('Scene boundaries overlap or leave a gap')
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
    if any(chr(0x4e0d) in str(slide) for slide in slides):
        raise RuntimeError('Promo narration contains forbidden U+4E0D')
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
