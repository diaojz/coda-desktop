"""把单张透明小哒 PNG 合成为带动效的 apng。
动效组合（按状态选）：breathe 呼吸缩放 / float 上下浮 / sway 左右摇 / squash 挤压 / bob 弹跳。
"""
import sys, math, json
import numpy as np
from PIL import Image

def crop_content(im):
    a=np.array(im); m=a[:,:,3]>30
    ys,xs=np.where(m.any(1))[0],np.where(m.any(0))[0]
    return im.crop((xs[0],ys[0],xs[-1]+1,ys[-1]+1))

def make_apng(src, out, effects, frames=28, size=200, fps_ms=70, shadow=True):
    base=crop_content(Image.open(src).convert("RGBA"))
    # 缩到目标高
    sc=size/base.height; base=base.resize((max(1,round(base.width*sc)),size),Image.LANCZOS)
    bw,bh=base.size
    # 画布留出动效余量
    PAD=int(size*0.18)
    CW=bw+2*PAD; CH=bh+2*PAD
    out_frames=[]
    for i in range(frames):
        t=i/frames                      # 0..1 循环相位
        ph=t*2*math.pi
        # 各动效幅度（默认 0）
        breathe = effects.get("breathe",0)
        floaty  = effects.get("float",0)
        sway    = effects.get("sway",0)
        bob     = effects.get("bob",0)
        squash  = effects.get("squash",0)
        # 缩放（呼吸/挤压：x、y 反相）
        sxsy = 1.0
        scl_x = 1 + breathe*math.sin(ph) + squash*math.sin(ph)
        scl_y = 1 + breathe*math.sin(ph) - squash*math.sin(ph)
        fw,fh=max(1,round(bw*scl_x)),max(1,round(bh*scl_y))
        layer=base.resize((fw,fh),Image.LANCZOS)
        # 旋转（摇摆）
        if sway:
            layer=layer.rotate(sway*math.sin(ph), resample=Image.BICUBIC, expand=True)
        # 位移
        dy = floaty*math.sin(ph)*size + (abs(bob*math.sin(ph))* -size)   # bob 向上弹
        dx = 0
        canvas=Image.new("RGBA",(CW,CH),(0,0,0,0))
        # 影子（贴地，随呼吸缩放，不随浮动上移）
        if shadow:
            from PIL import ImageDraw
            d=ImageDraw.Draw(canvas)
            sw=int(bw*0.5*scl_x); sh=max(3,int(size*0.035))
            cx=CW//2; cy=PAD+bh-int(size*0.01)
            d.ellipse([cx-sw//2,cy-sh//2,cx+sw//2,cy+sh//2],fill=(0,0,0,55))
        # 角色（底部对齐 baseline，叠加浮动）
        px=(CW-fw)//2; py=PAD+(bh-fh)+int(dy)
        canvas.alpha_composite(layer,(px,py))
        out_frames.append(canvas)
    out_frames[0].save(out,save_all=True,append_images=out_frames[1:],
                       duration=fps_ms,loop=0,disposal=2,format="PNG",optimize=True)
    import os; return os.path.getsize(out)//1024, (CW,CH), frames

if __name__=="__main__":
    src,out=sys.argv[1],sys.argv[2]
    eff=json.loads(sys.argv[3]) if len(sys.argv)>3 else {"breathe":0.025,"float":0.012}
    kb,size,n=make_apng(src,out,eff)
    print(f"{out.split('/')[-1]}  {kb}KB  {size}  {n}帧")
