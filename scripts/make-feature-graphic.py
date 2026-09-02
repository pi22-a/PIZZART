"""
Play 스토어 대표 이미지(1024×500)를 만든다.

    python3 scripts/make-feature-graphic.py

원본(이젤 위의 피자 조각)은 정사각형이고 분홍 배경이 깔려 있다. 배경을 걷어내
피사체만 남기고, 오른쪽에 놓은 뒤 왼쪽에 이름을 넣는다.

**스토어는 이 그림 위에 앱 이름과 설치 버튼을 겹쳐 올린다.** 그래서 가운데 아래는
비워두고 피사체를 오른쪽으로 몰았다.

배경을 걷어내는 데 두 단계가 필요했다.

1. 가장자리에서 시작하는 채우기 — 다만 색 거리로 판정하면 **이젤 아래 그림자**가
   안 지워진다(모서리 245,188,180 대 그림자 210,149,151). 그래서 "분홍 계열인가"로
   판정한다: G와 B가 비슷하고 R만 높은 색. 크러스트는 B가 한참 낮아 안 걸린다.
2. **이젤 다리 사이에 갇힌 배경**은 가장자리에서 못 닿는다. 배경색과 거의 똑같은
   (오차 12 이내) 덩어리 중 큰 것만 따로 지운다. 피자의 밝은 부분(238,202,195)은
   배경과 G·B가 14 이상 달라서 살아남는다.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from collections import deque
import pathlib

SRC = pathlib.Path('pizzart_icon.png')
OUT = pathlib.Path('../PIZZART-release/store/icon')
W, H = 1024, 500

im = Image.open(SRC).convert('RGBA')
w, h = im.size
px = im.load()
BG = im.convert('RGB').getpixel((5, 5))

def pinkish(c):
    r, g, b = c[:3]
    return abs(g - b) < 28 and (r - g) > 28 and r > 150

def near_bg(c, tol=12):
    return all(abs(c[i] - BG[i]) <= tol for i in range(3))

def flood(seeds, test):
    q, n = deque(seeds), 0
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h: continue
        c = px[x, y]
        if c[3] == 0 or not test(c): continue
        px[x, y] = (c[0], c[1], c[2], 0); n += 1
        q.extend([(x+1,y),(x-1,y),(x,y+1),(x,y-1)])
    return n

edge = ([(x,0) for x in range(w)] + [(x,h-1) for x in range(w)]
        + [(0,y) for y in range(h)] + [(w-1,y) for y in range(h)])
flood(edge, pinkish)

visited = bytearray(w*h)
for sy in range(0, h, 4):
    for sx in range(0, w, 4):
        if visited[sy*w+sx]: continue
        if px[sx,sy][3] == 0 or not near_bg(px[sx,sy]): continue
        comp, q, seen = [], deque([(sx,sy)]), set()
        while q:
            x, y = q.popleft()
            if (x,y) in seen or x<0 or y<0 or x>=w or y>=h: continue
            seen.add((x,y))
            c = px[x,y]
            if c[3] == 0 or not near_bg(c): continue
            comp.append((x,y)); q.extend([(x+1,y),(x-1,y),(x,y+1),(x,y-1)])
        for (x,y) in comp: visited[y*w+x] = 1
        if len(comp) > 1500:
            for (x,y) in comp:
                c = px[x,y]; px[x,y] = (c[0],c[1],c[2],0)

# 잘라낸 자리가 칼같으면 합성했을 때 티가 난다
im.putalpha(im.getchannel('A').filter(ImageFilter.GaussianBlur(0.8)))
subj = im.crop(im.getbbox())
OUT.mkdir(parents=True, exist_ok=True)
subj.save(OUT/'easel-cutout.png')

def font(size):
    for c, idx in [('/System/Library/Fonts/AppleSDGothicNeo.ttc', 9),
                   ('/System/Library/Fonts/HelveticaNeue.ttc', 0)]:
        try: return ImageFont.truetype(c, size, index=idx)
        except Exception: pass
    return ImageFont.load_default()

def build(name, bg, fg, sub_fg, accent):
    g = Image.new('RGB', (W,H), bg); d = ImageDraw.Draw(g)
    sh = int(H*0.94); sw = int(subj.size[0]*sh/subj.size[1])
    s = subj.resize((sw,sh), Image.LANCZOS)
    g.paste(s, (W-sw-70, H-sh-6), s)
    d.text((64,168), 'PIZZART', font=font(96), fill=fg)
    d.text((70,282), '피자르트', font=font(30), fill=accent)
    d.text((70,328), '한 조각으로 맞히는 그림 추리', font=font(30), fill=sub_fg)
    g.save(OUT/name, quality=95)
    print(f'  {name} — {W}×{H}')

build('feature-dark.png',  (24,24,24),    (246,239,226), (164,156,146), (224,128,58))
build('feature-pink.png',  (246,188,181), (60,32,30),    (122,72,66),   (198,58,48))
