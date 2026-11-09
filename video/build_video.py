# -*- coding: utf-8 -*-
"""花艺图库操作说明视频后期构建脚本：剪辑、加速、统一规格、拼接、烧录字幕。"""
import imageio_ffmpeg, subprocess, os, re, json

FF = imageio_ffmpeg.get_ffmpeg_exe()
SRC = 'video'
BUILD = os.path.join(SRC, 'build')
os.makedirs(BUILD, exist_ok=True)

# 剪辑表：镜头 -> (源文件, [(起, 止, 倍速), ...], [每段对应字幕])
SHOTS = [
    ('s1_open', 'c76d3b54fe3aeb6ae605df8656687ef0.mp4', [(0, 3, 1)],
     ['花艺图库｜上传照片，AI 自动打标，按标签秒查作品']),
    ('s2_activate', '2801fce540eda4b9537bf21071f9a7b3.mp4', [(0, 7.5, 1), (15.2, 20.5, 1)],
     ['新用户在「我的」填写名字和校验码，一键开通', '开通后自动识别身份，无需重复输入']),
    ('s3_upload', '94a069d77bb52c155b67dd3ee36261be.mp4',
     [(2, 12, 1.5), (12, 34, 2.5), (34, 44, 1), (44, 49.8, 1)],
     ['从相册选择作品照片，默认无损上传，保留高清原图',
      '内容安全校验后，视觉大模型自动分析图片',
      'AI 自动提取颜色、花材、种类、风格、用途等标签，人工确认后入库',
      '保存后正式归档到作品墙']),
    ('s4_wall', 'b32d8ab371b62b3bc19af6f9ac8befbe.mp4', [(0, 4.29, 1)],
     ['所有归档作品按时间瀑布流展示']),
    ('s5_filter', 'be6bbb55931cb900254cadceef09210d.mp4', [(3, 18.5, 1)],
     ['同维度多选为「或」，跨维度为「与」，组合筛选一秒定位']),
    ('s6_detail', 'fd6db5fb7b3b2b4350bbe050d44f670b.mp4',
     [(2, 7, 1), (12, 19, 1), (23, 28, 2), (33, 35, 1), (49, 58, 1)],
     ['详情页支持查看原图与添加附加图',
      '点击查看高清原图，作品细节清晰可见',
      '每个作品最多可添加 8 张附加图',
      '上传附加图',
      '顶部左右滑动，即可切换多角度照片']),
    ('s7_edit', '76bd9895e94ca2c5e0c43cd3944d2fc7.mp4', [(0, 4.5, 1)],
     ['标签可随时人工修正，保存后立即生效']),
    ('s8_share', 'd77bec40e25c6e94de0b1441677c0ed6.mp4', [(12, 21, 1), (34.5, 39.9, 1)],
     ['开启作品分享，即可发送给微信好友', '对方以只读模式查看该作品，停止分享后链接立即失效']),
    ('s9_stats', 'a83c2d0aa2e02e64ac5fdee8a5e637e5.mp4', [(0, 6.7, 1)],
     ['个人作品统计一目了然 —— 让每一束花都记得']),
]

W, H, FPS = 720, 1600, 30

def run(args, **kw):
    r = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', errors='replace', **kw)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-3000:])
    return r

def duration(path):
    r = subprocess.run([FF, '-i', path], capture_output=True, text=True, encoding='utf-8', errors='replace')
    m = re.search(r'Duration: (\d+):(\d+):([\d.]+)', r.stderr)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

timeline = []  # (镜头, 片内起, 片内止, 字幕)
concat_lines = []
t_cursor = 0.0
seg_idx = 0
for shot, src, parts, subs in SHOTS:
    assert len(parts) == len(subs), shot
    for (start, end, speed), sub in zip(parts, subs):
        seg = os.path.join(BUILD, f'seg{seg_idx:02d}.mp4')
        vf = (f'trim=start={start}:end={end},setpts=(PTS-STARTPTS)/{speed},'
              f'scale={W}:{H}:force_original_aspect_ratio=decrease,'
              f'pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0xF7F8F3,fps={FPS},format=yuv420p')
        run([FF, '-y', '-ss', '0', '-i', os.path.join(SRC, src),
             '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', seg])
        d = duration(seg)
        timeline.append({'shot': shot, 'seg': seg, 'start': t_cursor, 'end': t_cursor + d, 'sub': sub})
        concat_lines.append(f"file 'seg{seg_idx:02d}.mp4'")
        t_cursor += d
        seg_idx += 1
        print(f'{shot} [{start}-{end}] x{speed} -> {d:.2f}s | {sub}')

with open(os.path.join(BUILD, 'list.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(concat_lines))

def ass_time(t):
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return f'{h}:{m:02d}:{s:05.2f}'

header = """[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1600
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,34,&H00FFFFFF,&H00FFFFFF,&H002E3B30,&HA0000000,-1,0,0,0,100,100,0,0,3,10,0,2,36,36,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
def wrap_sub(text, max_units=32):
    """按显示宽度（中文 2、英文 1）将超过一行的字幕在标点附近折行。"""
    units = sum(2 if ord(c) > 0x2E7F else 1 for c in text)
    if units <= max_units:
        return text
    best, best_diff = None, 1e9
    acc = 0
    for i, c in enumerate(text):
        acc += 2 if ord(c) > 0x2E7F else 1
        if c in '，。；、：｜—— ' and i >= len(text) * 0.3:
            diff = abs(acc - units / 2)
            if diff < best_diff:
                best, best_diff = i + (2 if text[i:i+2] == '——' else 1), diff
    if best is None or best >= len(text):
        best = len(text) // 2
    return text[:best].strip() + '\\N' + text[best:].strip()

events = []
for it in timeline:
    events.append(f"Dialogue: 0,{ass_time(it['start'] + 0.1)},{ass_time(it['end'] - 0.05)},Default,,0,0,0,,{wrap_sub(it['sub'])}")
with open(os.path.join(BUILD, 'subs.ass'), 'w', encoding='utf-8-sig') as f:
    f.write(header + '\n'.join(events) + '\n')

with open(os.path.join(BUILD, 'timeline.json'), 'w', encoding='utf-8') as f:
    json.dump(timeline, f, ensure_ascii=False, indent=2)

print(f'TOTAL: {t_cursor:.2f}s, segments: {seg_idx}')
