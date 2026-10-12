#!/usr/bin/env python3
"""
Иконки приложения (PWA) из apple-touch-icon, которая лежит в index.html.

    python3 tools/make-app-icons.py

Откуда такой источник: в index.html уже встроена чёткая иконка 180×180 с фирменным
знаком. Пробовали вместо неё увеличивать логотип 90 px из той же страницы — на 512 px
вылезли рваные края, светлая кайма от сглаживания и артефакты на срезанных углах.
Не повторяйте: если появится логотип в векторе (SVG), иконки лучше делать из него.

Пишет в assets/: icon-192.png, icon-512.png, icon-maskable-512.png.
Зависимостей нет — PNG разбирается и собирается вручную через zlib.
"""
import io,re,zlib,struct,base64
html=io.open('index.html',encoding='utf-8',newline='').read()
b64=re.search(r'<link rel="apple-touch-icon" href="data:image/png;base64,([^"]+)"',html).group(1)
data=base64.b64decode(b64)
def png_read(data):
    pos=8; idat=b''; plte=None; trns=None
    while pos<len(data):
        ln=int.from_bytes(data[pos:pos+4],'big'); typ=data[pos+4:pos+8]
        chunk=data[pos+8:pos+8+ln]; pos+=12+ln
        if typ==b'IHDR': w,h,bd,ct,comp,filt,inter=struct.unpack('>IIBBBBB',chunk)
        elif typ==b'IDAT': idat+=chunk
        elif typ==b'PLTE': plte=chunk
        elif typ==b'tRNS': trns=chunk
        elif typ==b'IEND': break
    raw=zlib.decompress(idat); nch={0:1,2:3,3:1,4:2,6:4}[ct]; stride=w*nch
    out=bytearray(); prev=bytearray(stride); i=0
    for y in range(h):
        f=raw[i]; i+=1; line=bytearray(raw[i:i+stride]); i+=stride
        if f==1:
            for x in range(nch,stride): line[x]=(line[x]+line[x-nch])&255
        elif f==2:
            for x in range(stride): line[x]=(line[x]+prev[x])&255
        elif f==3:
            for x in range(stride):
                a=line[x-nch] if x>=nch else 0
                line[x]=(line[x]+((a+prev[x])>>1))&255
        elif f==4:
            for x in range(stride):
                a=line[x-nch] if x>=nch else 0
                b=prev[x]; c=prev[x-nch] if x>=nch else 0
                p=a+b-c; pa=abs(p-a); pb=abs(p-b); pc=abs(p-c)
                pr=a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
                line[x]=(line[x]+pr)&255
        out+=line; prev=line
    return w,h,ct,nch,bytes(out),plte,trns
W,H,ct,nch,pix,plte,trns=png_read(data)
print('источник',W,'x',H,'тип',ct)
WHITE=(255,255,255)
def px(x,y):
    i=(y*W+x)*nch
    if ct==6:
        a=pix[i+3]/255.0
        return tuple(int(round(pix[i+k]*a+255*(1-a))) for k in range(3))
    if ct==2: return (pix[i],pix[i+1],pix[i+2])
    if ct==3:
        p=pix[i]; return (plte[p*3],plte[p*3+1],plte[p*3+2])
    return (pix[i],)*3
def sample(fx,fy):
    fx=min(max(fx,0),W-1.001); fy=min(max(fy,0),H-1.001)
    x0,y0=int(fx),int(fy); dx,dy=fx-x0,fy-y0; acc=[0.0]*3
    for (xx,yy,wt) in ((x0,y0,(1-dx)*(1-dy)),(x0+1,y0,dx*(1-dy)),(x0,y0+1,(1-dx)*dy),(x0+1,y0+1,dx*dy)):
        c=px(min(xx,W-1),min(yy,H-1))
        for k in range(3): acc[k]+=wt*c[k]
    return tuple(int(round(v)) for v in acc)
def write(path,size,rows):
    def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(rows),9))+chunk(b'IEND',b'')
    io.open(path,'wb').write(png); print(path,size,'px,',len(png),'байт')
def make(size,fill,path):
    inner=int(round(size*fill)); off=(size-inner)//2
    rows=bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            if off<=x<off+inner and off<=y<off+inner:
                rows+=bytes(sample((x-off)*(W-1)/(inner-1),(y-off)*(H-1)/(inner-1)))
            else: rows+=bytes(WHITE)
    write(path,size,rows)
make(192,1.0,'assets/icon-192.png')
make(512,1.0,'assets/icon-512.png')
# maskable: система обрежет иконку по кругу или скруглённому квадрату, поэтому знак
# ужимаем в безопасную зону — внутренние 80 % диаметра, с запасом.
make(512,0.66,'assets/icon-maskable-512.png')
