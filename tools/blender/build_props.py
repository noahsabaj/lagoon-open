"""Build the Lagoon Open prop library, check the exported GLBs, and photograph them in Cycles."""
import json
import math
import random
import struct
import tempfile
import zlib
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "public/models/props"
PREVIEWS = ROOT / "tools/blender/previews/props"
TAU = math.tau
PI = math.pi
V = Vector
MATERIALS = {}
WOOD = set()
FONTS = {}


def linear(c):
    c /= 255
    return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4


def color(hexcode):
    return tuple(linear(int(hexcode[i:i + 2], 16)) for i in (0, 2, 4))


def material(name, hexcode, rough=.5, metal=0, glow=0, alpha=1, two_sided=False, coat=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color(hexcode), alpha)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color(hexcode), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = .25
    p.inputs["Alpha"].default_value = alpha
    if glow:
        p.inputs["Emission Color"].default_value = (*color(hexcode), 1)
        p.inputs["Emission Strength"].default_value = glow
    m.use_backface_culling = not two_sided
    if alpha < 1:
        m.surface_render_method = 'BLENDED'
    MATERIALS[name] = m
    return m


def png(path, w, h, pixels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + pixels[y * w * 3:(y + 1) * w * 3] for y in range(h))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b'IHDR', struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


def attach_image(mat, path, emission=False):
    img = bpy.data.images.load(str(path))
    img.pack()
    m = MATERIALS[mat]
    tex = m.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    p = m.node_tree.nodes.get("Principled BSDF")
    m.node_tree.links.new(tex.outputs['Color'], p.inputs['Base Color'])
    if emission:
        m.node_tree.links.new(tex.outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = .35


def make_wood(folder, name, base, rough):
    """Seamless sawn figure and narrow pores. U follows the length of the timber."""
    material(name, base, rough)
    rgb = tuple(int(base[i:i + 2], 16) for i in (0, 2, 4))
    pixels = bytearray()
    rng = random.Random(928)
    for row in range(128):
        y = TAU * row / 128
        for col in range(256):
            x = TAU * col / 256
            drift = .075 * math.sin(x + 1.6 * math.sin(y)) + .030 * math.sin(2*x - y)
            cut = y + drift + .045 * math.sin(2*y + .7*math.sin(x))
            figure = (.033*math.sin(3*cut) + .045*math.sin(9*cut + .5*math.sin(x)) +
                      .025*math.sin(24*cut) - .050*max(0, math.sin(34*cut + .8*math.sin(x)))**8 +
                      rng.uniform(-.013, .013))
            pixels.extend(max(0, min(255, round(c * (1 + figure)))) for c in rgb)
    path = folder / (name + ".png")
    png(path, 256, 128, pixels)
    attach_image(name, path)
    WOOD.add(name)


# The same five-by-seven LED modules draw the score, player names, and legends.
DIGITS = dict(zip('0123456789', [
    (14,17,19,21,25,17,14), (4,12,4,4,4,4,14), (14,17,1,2,4,8,31),
    (30,1,1,14,1,1,30), (2,6,10,18,31,2,2), (31,16,16,30,1,1,30),
    (6,8,16,30,17,17,14), (31,1,2,4,8,8,8), (14,17,17,14,17,17,14),
    (14,17,17,15,1,2,12)]))
DIGITS.update(dict(zip('ABCDEFGHIJKLMNOPQRSTUVWXYZ', [
    (14,17,17,31,17,17,17),(30,17,17,30,17,17,30),(15,16,16,16,16,16,15),
    (30,17,17,17,17,17,30),(31,16,16,30,16,16,31),(31,16,16,30,16,16,16),
    (15,16,16,23,17,17,15),(17,17,17,31,17,17,17),(14,4,4,4,4,4,14),
    (7,2,2,2,18,18,12),(17,18,20,24,20,18,17),(16,16,16,16,16,16,31),
    (17,27,21,21,17,17,17),(17,25,25,21,19,19,17),(14,17,17,17,17,17,14),
    (30,17,17,30,16,16,16),(14,17,17,17,21,18,13),(30,17,17,30,20,18,17),
    (15,16,16,14,1,1,30),(31,4,4,4,4,4,4),(17,17,17,17,17,17,14),
    (17,17,17,17,17,10,4),(17,17,17,21,21,27,17),(17,17,10,4,10,17,17),
    (17,17,10,4,4,4,4),(31,1,2,4,8,16,31)])))
DIGITS[' '] = (0,)*7


def scoreboard_image(folder):
    w, h = 660, 290
    data = bytearray(w*h*3)
    def fill(x, y, width, height, rgb):
        run = bytes(rgb)*width
        for yy in range(y, y + height):
            i = (yy*w+x)*3
            data[i:i+len(run)] = run
    def lettering(s, x, y, size, rgb):
        for ch in s:
            for yy, mask in enumerate(DIGITS[ch]):
                for xx in range(5):
                    if mask & (16 >> xx):
                        fill(x+xx*size, y+yy*size, size if size < 4 else size-1, size if size < 4 else size-1, rgb)
            x += 6*size
    fill(0, 0, w, h, (11, 34, 40))
    fill(0, 0, w, 55, (19, 58, 62))
    fill(17, 20, 7, 14, (255, 165, 89))
    lettering("CENTRE COURT", 38, 20, 2, (174, 217, 207))
    lettering("LIVE", 586, 20, 2, (247, 182, 104))
    lettering("SINGLES", 28, 73, 2, (124, 165, 163))
    lettering("SET", 419, 73, 2, (124, 165, 163))
    lettering("PTS", 543, 73, 2, (237, 175, 98))
    fill(27, 102, 606, 2, (65, 102, 103))
    fill(27, 187, 606, 2, (52, 83, 87))
    fill(28, 121, 5, 42, (246, 173, 89))
    ivory = (223, 236, 218)
    for y, player, games, points in [(124, "REYES", "3", "40"), (211, "COSTA", "2", "30")]:
        lettering(player, 50, y, 6, ivory)
        lettering(games, 419, y, 6, (153, 203, 188))
        lettering(points, 535, y, 6, (255, 184, 103))
    # A default CanvasTexture expects V=1 at the top. The embedded idle graphic shares that UV.
    rows = [data[i:i+w*3] for i in range(0, len(data), w*3)]
    path = folder / "Centre_Court_Idle.png"
    png(path, w, h, b''.join(reversed(rows)))
    attach_image("Court_Display", path, emission=True)


def palette(folder):
    for name, col, rough, metal in [
        ("Deep_Jade","184C4C",.34,.58), ("Sea_Enamel","217874",.32,.45),
        ("Graphite","283C43",.36,.63), ("Silver","B5C6C5",.31,.78),
        ("Brass","C39551",.32,.69), ("Rubber","273337",.80,0),
        ("Porcelain","F4E8CE",.36,.08), ("Piping","E9CC9C",.62,0),
        ("Coral","C94B3C",.48,0), ("Gold_Paint","E5AC4A",.42,.08),
        ("Ink","102C37",.31,.18), ("Court_Display","173C43",.62,0),
        ("Concrete","A8B4AE",.85,0), ("Iron","304346",.51,.68),
    ]:
        material(name,col,rough,metal)
    for name, col in [('Cushion','F4E6CA'),('Cloth_Coral','CA5143'),('Cloth_Cream','F8EDD3'),
                      ('Mat_CanopyA','E9AC46'),('Mat_CanopyB','F7EBCF'),('Towel','F7EED9'),
                      ('Towel_Stripe','338D8B'),('Sail_Ivory','F4E9CD'),('Sail_Honey','E8AE51'),
                      ('Sail_Seam','CFBB92'),('Sail_AmberSeam','BB843D')]:
        material(name,col,.83,two_sided=True)
    for name, col, rough in [('Teak','AF7348',.44),('Cedar','C18B5D',.46),('Pier_Timber','725541',.52)]:
        make_wood(folder,name,col,rough)
    for name, col, rough in [
        ('Glazed_Clay','B96646',.27),('Ochre_Glaze','D5895D',.27),('Umber_Glaze','824832',.31),
        ('Earth','493D34',.96),('Pebble','B4A28A',.88),('Palm_Bark','91775A',.9),
        ('Palm_Scar','AE936D',.82),('Bark_Shadow','796749',.91),('Coconut','936839',.83),
        ('Coconut_Green','91904C',.83),('Crown','788347',.73),('Leaf_Rib','91A455',.68),
        ('Masonry','898879',.88),('Stone_Light','ADA897',.88),('Stone_Warm','9F9581',.9),
        ('Stone_Shade','929184',.94),('Limewash','F3E5CE',.77),('Signal_Red','C44C3E',.64),
        ('Copper','A65C44',.38),('Hull_White','F1ECE0',.23),('Antifoul','265B61',.54),
        ('Ball_Felt','D4EA43',.94),('Ball_Sun','DBED4B',.93),('Ball_Seam','F5F1D7',.86),
    ]:
        material(name,col,rough, .52 if name=='Copper' else 0, coat=.23 if 'Glaze' in name or name=='Hull_White' else 0)
    for name, col in [('Leaf_Emerald','29744D'),('Leaf_Jade','38845A'),('Leaf_Light','5B9C61'),
                      ('Leaf_Sun','77AD69'),('Leaf_Deep','246A48')]:
        material(name,col,.66,two_sided=True)
    material('Lantern_Glass','9FC9BE',.2,.05,alpha=.17,two_sided=True)
    material('Mat_LanternGlow','FFBE67',.32,glow=2.3)
    material('Mat_FloodGlow','FFF2DA',.24,glow=2.1)
    material('Mat_LampGlow','FFD58C',.25,glow=3.5)
    scoreboard_image(folder)


class Geometry:
    """Batch parts by material. Semantic meshes with a runtime contract keep their own name."""
    def __init__(self, name):
        self.name = name
        self.parts = {}
        self.matrix = Matrix.Identity(4)
        self.serial = 0

    @contextmanager
    def space(self, location=(0,0,0), angles=(0,0,0), scale=(1,1,1)):
        old = self.matrix
        self.matrix = old @ Matrix.LocRotScale(V(location), Euler(angles).to_quaternion(), V(scale))
        try:
            yield
        finally:
            self.matrix = old

    def add(self, vertices, faces, mats, smooth=False, *, grain=None, uvs=None, part=None):
        self.serial += 1
        local = [V(v) for v in vertices]
        world = [tuple(self.matrix @ v) for v in local]
        indices = defaultdict(dict)
        extents = [max(p[k] for p in local)-min(p[k] for p in local) for k in range(3)]
        grain = max(range(3), key=extents.__getitem__) if grain is None else grain
        for i, face in enumerate(faces):
            mat = mats if isinstance(mats, str) else mats[i]
            key = (part or (self.name + "_" + mat), mat)
            vs, fs, smoothing, loops = self.parts.setdefault(key, ([], [], [], []))
            remap = indices[key]
            for v in face:
                if v not in remap:
                    remap[v] = len(vs)
                    vs.append(world[v])
            fs.append(tuple(remap[v] for v in face))
            smoothing.append(smooth if isinstance(smooth, bool) else smooth[i])
            if uvs is not None:
                loops.extend(uvs[i])
            elif mat in WOOD:
                n = (local[face[1]]-local[face[0]]).cross(local[face[-1]]-local[face[0]])
                normal = max(range(3), key=lambda k: abs(n[k]))
                axis = grain if grain != normal else (normal+1)%3
                cross = 3-normal-axis
                loops.extend((local[v][axis]/1.8 + (self.serial*.317)%1,
                              local[v][cross]/.49 + (self.serial*.713)%1) for v in face)

    def finish(self):
        objects = []
        for (name, mat), (vs, fs, smooth, uv) in self.parts.items():
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(vs, [], fs)
            mesh.materials.append(MATERIALS[mat])
            mesh.polygons.foreach_set("use_smooth", smooth)
            if uv:
                assert len(uv) == len(mesh.loops), name
                layer = mesh.uv_layers.new(name="UVMap")
                layer.uv.foreach_set("vector", [t for pair in uv for t in pair])
            mesh.update()
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.scene.collection.objects.link(obj)
            objects.append(obj)
        return objects


def rounds(w, d, r, steps=2):
    r = min(r, w/2-.00001, d/2-.00001)
    points = []
    for k,(sx,sy) in enumerate([(1,1),(-1,1),(-1,-1),(1,-1)]):
        for j in range(steps+1):
            a = (k+j/steps)*PI/2
            points.append((sx*(w/2-r)+r*math.cos(a), sy*(d/2-r)+r*math.sin(a)))
    return points


def loft(g, rings, mat, *, closed=True, smooth=True, **kw):
    n = len(rings[0])
    faces, materials, shading = [], [], []
    def add(face, band, shade):
        faces.append(face)
        materials.append(mat if isinstance(mat,str) else mat[band])
        shading.append(shade)
    if closed:
        add(tuple(reversed(range(n))),0,False)
    for j in range(len(rings)-1):
        for i in range(n):
            a = j*n+i
            b = j*n+(i+1)%n
            add((a,b,b+n,a+n), j, smooth if isinstance(smooth,bool) else smooth[j])
    if closed:
        add(tuple(range((len(rings)-1)*n,len(rings)*n)), len(rings)-2, False)
    g.add([v for ring in rings for v in ring],faces,materials,shading,**kw)


def box(g, mat, c, size, r=.015, bevel=None, steps=1, **kw):
    w,d,h = size
    r = min(r,w*.48,d*.48)
    b = min(r*.45 if bevel is None else bevel, h*.32, r*.8)
    profiles = [(-h/2,b),(-h/2+b,0),(h/2-b,0),(h/2,b)] if b>.0001 else [(-h/2,0),(h/2,0)]
    rings = [[(c[0]+x,c[1]+y,c[2]+z) for x,y in rounds(w-2*inset,d-2*inset,max(.0001,r-inset),steps)]
             for z,inset in profiles]
    loft(g,rings,mat,**kw)


def spin(g, mat, xy, profile, n=16, phase=0, smooth=True, **kw):
    rings = [[(xy[0]+r*math.cos(phase+i*TAU/n),xy[1]+r*math.sin(phase+i*TAU/n),z)
              for i in range(n)] for r,z in profile]
    loft(g,rings,mat,smooth=smooth,**kw)


def tube(g, mat, points, radius, n=8, *, loop=False, caps=True, smooth=True, **kw):
    ps = [V(p) for p in points]
    rs = [radius]*len(ps) if isinstance(radius,(int,float)) else radius
    rings = []
    axis = None
    for i,p in enumerate(ps):
        prev = ps[(i-1)%len(ps)] if loop or i else p
        nxt = ps[(i+1)%len(ps)] if loop or i+1<len(ps) else p
        t = ((p-prev).normalized() + (nxt-p).normalized()).normalized()
        if axis is None:
            axis = t.cross(V((0,0,1)) if abs(t.z)<.9 else V((0,1,0))).normalized()
        axis = (axis-t*axis.dot(t)).normalized()
        other = t.cross(axis)
        rings.append([p+rs[i]*(axis*math.cos(j*TAU/n)+other*math.sin(j*TAU/n)) for j in range(n)])
    if loop:
        verts = [v for ring in rings for v in ring]
        faces = [(i*n+j,i*n+(j+1)%n,((i+1)%len(ps))*n+(j+1)%n,((i+1)%len(ps))*n+j)
                 for i in range(len(ps)) for j in range(n)]
        g.add(verts,faces,mat,smooth,**kw)
    else:
        loft(g,rings,mat,closed=caps,smooth=smooth,**kw)


def rod(g, mat, a, b, r, n=8, **kw):
    tube(g,mat,[a,b],r,n,**kw)


def rim(g,mat,c,w,d,r,wire,n=6,steps=3):
    tube(g,mat,[(c[0]+x,c[1]+y,c[2]) for x,y in rounds(w,d,r,steps)],wire,n,loop=True)


def ellipse(g,mat,center,radii,n=12,rings=6):
    pts=[(center[0],center[1],center[2]-radii[2])]
    for j in range(1,rings):
        lat=-PI/2+j*PI/rings
        for i in range(n):
            a=i*TAU/n
            pts.append((center[0]+radii[0]*math.cos(lat)*math.cos(a),
                        center[1]+radii[1]*math.cos(lat)*math.sin(a),center[2]+radii[2]*math.sin(lat)))
    top=len(pts)
    pts.append((center[0],center[1],center[2]+radii[2]))
    faces=[(0,1+(i+1)%n,1+i) for i in range(n)]
    for j in range(rings-2):
        for i in range(n):
            a=1+j*n+i
            b=1+j*n+(i+1)%n
            faces.append((a,b,b+n,a+n))
    faces.extend((top-n+i,top-n+(i+1)%n,top) for i in range(n))
    g.add(pts,faces,mat,True)


def arc_points(x,y,z,r,n):
    return [(x+r*math.cos(i*TAU/n),y+r*math.sin(i*TAU/n),z) for i in range(n)]


def bezier(a,b,c,d,steps):
    a,b,c,d=map(V,(a,b,c,d))
    return [a*(1-t)**3+3*b*t*(1-t)**2+3*c*t*t*(1-t)+d*t**3 for t in [i/steps for i in range(steps+1)]]


def font(key, path):
    if key not in FONTS:
        FONTS[key] = bpy.data.fonts.load(path) if Path(path).exists() else bpy.data.fonts.get("Bfont Regular")
    return FONTS[key]


def type_mesh(g, mat, label, center, size, *, spacing=1.0, align='CENTER', face=None):
    curve = bpy.data.curves.new("Typesetting", 'FONT')
    curve.body, curve.align_x, curve.align_y = label, align, 'CENTER'
    curve.size, curve.space_character, curve.resolution_u = size, spacing, 3
    if face:
        curve.font=face
    o = bpy.data.objects.new("Typesetting",curve)
    bpy.context.scene.collection.objects.link(o)
    ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = ev.to_mesh()
    verts = [V(center)+v.co for v in mesh.vertices]
    faces = [tuple(p.vertices) for p in mesh.polygons]
    g.add(verts,faces,mat)
    ev.to_mesh_clear()
    bpy.data.objects.remove(o,do_unlink=True)
    bpy.data.curves.remove(curve)


def umpire_chair(g):
    for sy in (-1,1):
        for foot, shoulder in [(-.49,-.245),(.65,.235)]:
            x,y=foot,sy*.445
            spin(g,'Rubber',(x,y),[(.055,0),(.058,.012),(.053,.055),(.044,.073)],10)
            rod(g,'Silver',(x,y,.046),(shoulder,sy*.311,1.55),.036,10)
        tube(g,'Deep_Jade',[(-.478,sy*.439,.11),(-.46,sy*.44,.165),
                            (.595,sy*.44,.165),(.63,sy*.438,.13)],.022)
        rod(g,'Deep_Jade',(-.46,sy*.425,.25),(.29,sy*.334,1.31),.016,6)
        rod(g,'Deep_Jade',(.60,sy*.428,.24),(-.263,sy*.337,1.30),.016,6)
        tube(g,'Deep_Jade',[(-.23,sy*.315,1.48),(-.28,sy*.33,1.73),(-.345,sy*.33,2.10),
                            (-.385,sy*.366,2.51),(-.34,sy*.38,2.62)],.023,8)
        tube(g,'Silver',[(.20,sy*.311,1.51),(.195,sy*.338,1.78),(.15,sy*.345,1.81),
                         (-.255,sy*.345,1.81)],.021)
        box(g,'Teak',(-.04,sy*.343,1.825),(.48,.072,.048),.032,steps=2)
    rod(g,'Deep_Jade',(-.46,-.414,.36),(-.46,.414,.36),.027)
    rod(g,'Silver',(-.31,-.34,1.21),(-.31,.34,1.21),.019)
    for j,z in enumerate((.30,.61,.92,1.23)):
        x=.65+(.235-.65)*z/1.55
        width=.86-.24*z/1.55
        box(g,'Teak',(x,0,z),(.169,width,.053),.018,steps=2)
        for dx in (.035,.061):
            box(g,'Brass',(x+dx,0,z+.0265),(.004,width-.065,.002),.001,bevel=0)
        for sy in (-1,1):
            rod(g,'Graphite',(x,sy*(width/2-.03),z-.011),(x,sy*(width/2+.022),z-.011),.026,8)
    box(g,'Deep_Jade',(0,0,1.535),(.59,.69,.078),.055,steps=2)
    box(g,'Cushion',(0,0,1.61),(.545,.605,.10),.085,.027,steps=4,part='Umpire_Seat')
    rim(g,'Piping',(0,0,1.627),.544,.604,.085,.005,steps=4)
    for z in (1.72,1.84,1.96,2.08):
        with g.space((-.257-(z-1.72)*.19,0,z),(0,-.18,0)):
            box(g,'Teak',(0,0,0),(.060,.615,.088),.019,steps=2)
            for y in (-.255,.255):
                rod(g,'Brass',(.030,y,0),(.033,y,0),.008,8)
    # Cantilevered writing desk, adjustable tablet stand, and microphone.
    tube(g,'Silver',[(.05,.30,1.58),(.08,.48,1.68),(.08,.48,1.80)],.023)
    box(g,'Cedar',(.04,.478,1.833),(.43,.247,.036),.042,steps=3)
    rod(g,'Graphite',(-.052,.50,1.85),(-.033,.52,1.907),.018)
    with g.space((-.048,.511,1.92),(.27,-.16,0)):
        box(g,'Graphite',(0,0,0),(.227,.135,.017),.015,steps=3)
        box(g,'Ink',(0,0,.009),(.205,.113,.004),.008,bevel=0)
        for j,width in enumerate((.126,.091,.107)):
            box(g,'Sea_Enamel',(-.027,.026-.023*j,.0115),(width,.006,.002),.002,bevel=0)
    spin(g,'Brass',(.19,.48),[(.026,1.851),(.026,1.864),(.017,1.87)],10)
    mic=bezier((.19,.48,1.862),(.19,.50,2.03),(.15,.36,2.04),(.125,.318,2.035),8)
    tube(g,'Graphite',mic,.007,6)
    ellipse(g,'Rubber',(.125,.312,2.035),(.016,.026,.014),10,4)
    # Barrel awning with a dropped scallop across both eaves.
    width, panels, depth = 1.10, 7, 1.13
    def roof(x,y,t):
        return 2.582+.150*(1-(2*(x-.02)/depth)**2)-.010*math.sin(PI*t)**2
    for panel in range(panels):
        mat=('Cloth_Coral','Cloth_Cream')[panel%2]
        y0=-width/2+width*panel/panels
        verts=[]
        for j in range(4):
            t=j/3
            y=y0+width/panels*t
            for i in range(9):
                x=.02+depth*(i/8-.5)
                verts.append((x,y,roof(x,y,t)))
        faces=[(j*9+i,j*9+i+1,j*9+i+10,j*9+i+9) for j in range(3) for i in range(8)]
        g.add(verts,faces,mat,True)
        for side in (-1,1):
            x=.02+side*depth/2
            hem=[]
            for i in range(7):
                t=i/6
                y=y0+width/panels*t
                z=roof(x,y,t)
                hem.append([(x,y,z),(x+side*.012,y,z-.045-.045*math.sin(PI*t))])
            order=(0,1,3,2) if side<0 else (2,3,1,0)
            g.add([p for row in hem for p in row],
                  [tuple(2*j+k for k in order) for j in range(6)],mat,True)
            tube(g,'Piping',[p[1] for p in hem],.004,5)
    for y in (-width/2,width/2):
        tube(g,'Brass',[(x,y,roof(x,y,0)-.008) for x in [-.545+i*depth/10 for i in range(11)]],.012,7)
    for x in (-.34,.41):
        rod(g,'Deep_Jade',(x,-.54,roof(x,0,0)-.027),(x,.54,roof(x,0,0)-.027),.015)


def bench_umbrella(g):
    for y in (-.735,.735):
        tube(g,'Deep_Jade',[(.19,y,.42),(.239,y,.079),(.221,y,.043),(.176,y,.032),
                            (-.192,y,.032),(-.229,y,.048),(-.239,y,.077),(-.184,y,.419)],.025,10)
        rod(g,'Silver',(-.215,y,.386),(.226,y,.386),.020)
        tube(g,'Deep_Jade',[(.192,y,.366),(.229,y,.475),(.323,y,.889)],.025)
        for x in (-.179,.163):
            box(g,'Rubber',(x,y,.014),(.095,.067,.028),.014)
    rod(g,'Deep_Jade',(-.13,-.74,.335),(-.13,.74,.335),.023)
    rod(g,'Silver',(.194,-.74,.313),(.194,.74,.313),.018)
    for j in range(5):
        box(g,'Teak',(-.202+j*.101,0,.434),(.093,2.01,.052),.014,steps=2,part='Bench_Seat',grain=1)
    for z in (.564,.676,.788,.888):
        with g.space((.204+(z-.46)*.23,0,z),(0,.222,0)):
            box(g,'Teak',(0,0,0),(.049,2.01,.088),.013,steps=2,grain=1)
            for y in (-.735,.735):
                rod(g,'Brass',(-.024,y,0),(-.027,y,0),.008,8)
    # A folded bath towel bends around the seat nose. Stripes follow the warp through the bend.
    towel_y=-.661
    path=[(.170,.469),(.118,.473),(.012,.475),(-.130,.472),(-.211,.470),
          (-.244,.463),(-.256,.448),(-.262,.405),(-.273,.324),(-.280,.260)]
    stripes=[(-.214,'Towel'),(-.196,'Towel_Stripe'),(-.183,'Towel'),(-.173,'Towel_Stripe'),
             (-.145,'Towel'),(.141,'Towel_Stripe'),(.168,'Towel'),(.180,'Towel_Stripe'),
             (.194,'Towel'),(.214,None)]
    for (lo,mat),(hi,_) in zip(stripes,stripes[1:]):
        verts=[]
        for i,(x,z) in enumerate(path):
            hang=i/(len(path)-1)
            for dy in (lo,hi):
                wave=math.sin((dy+.20)*39)
                verts.append((x-.009*wave*hang**3,towel_y+dy,z+.003*wave+.005*dy))
        g.add(verts,[(2*i,2*i+1,2*i+3,2*i+2) for i in range(len(path)-1)],mat,True)
    for i in range(17):
        dy=-.203+i*.0254
        x=-.28-.009*math.sin((dy+.20)*39)
        rod(g,'Piping',(x,towel_y+dy,.261),(x-.003,towel_y+dy+.003*math.sin(i),.243+.003*math.cos(i)),.0027,4)
    # Rounded insulated chest beside the bench.
    with g.space((-.015,1.335,0)):
        box(g,'Rubber',(0,0,.018),(.39,.365,.036),.034)
        box(g,'Sea_Enamel',(0,0,.201),(.452,.427,.349),.057,.022,steps=3)
        rim(g,'Porcelain',(0,0,.294),.451,.426,.058,.006,5)
        box(g,'Porcelain',(0,0,.391),(.466,.441,.072),.054,.018,steps=3)
        box(g,'Piping',(0,0,.427),(.372,.351,.009),.030,.003,steps=2)
        box(g,'Brass',(-.233,0,.345),(.018,.061,.062),.008)
        for y in (-.129,.129):
            rod(g,'Silver',(-.224,y,.235),(-.237,y,.235),.017)
        tube(g,'Silver',[(-.24,-.13,.235),(-.248,-.13,.169),(-.254,-.105,.154),
                         (-.254,.105,.154),(-.248,.13,.169),(-.24,.13,.235)],.009)
        rod(g,'Teak',(-.255,-.070,.154),(-.255,.070,.154),.014)
    # Twelve individually tailored gores, a scalloped valance and exposed timber stretchers.
    cx,cy=.95,0
    spin(g,'Concrete',(cx,cy),[(.265,0),(.28,.016),(.28,.069),(.234,.113),(.094,.124)],20)
    spin(g,'Brass',(cx,cy),[(.063,.123),(.065,.135),(.054,.208)],12)
    spin(g,'Teak',(cx,cy),[(.033,.165),(.032,1.95),(.027,2.865)],12,grain=2)
    for z in (1.08,2.24,2.80):
        spin(g,'Brass',(cx,cy),[(.035,z),(.038,z+.006),(.037,z+.029),(.033,z+.031)],12)
    def sail(p,t,s):
        a=TAU*(p+s)/12
        sag=math.sin(PI*s)**2
        radius=1.45*t*(1-.023*sag*t)
        z=2.901-.176*t-.190*t*t-.049*sag*t**1.24
        return V((cx+radius*math.cos(a),cy+radius*math.sin(a),z))
    for p in range(12):
        mat=('Mat_CanopyA','Mat_CanopyB')[p%2]
        verts=[sail(p,t,s/6) for t in (.027,.19,.39,.61,.82,1) for s in range(7)]
        faces=[(i*7+j,(i+1)*7+j,(i+1)*7+j+1,i*7+j+1) for i in range(5) for j in range(6)]
        g.add(verts,faces,mat,True)
        edges=[]
        for j in range(7):
            s=j/6
            top=sail(p,1,s)
            radial=V((top.x-cx,top.y-cy,0)).normalized()
            bottom=top+radial*.009-V((0,0,.050+.063*math.sin(PI*s)))
            edges.append((top,bottom))
        g.add([v for e in edges for v in e],[(2*j,2*j+1,2*j+3,2*j+2) for j in range(6)],mat,True)
        tube(g,'Piping',[e[1] for e in edges],.0045,5)
        rib=[sail(p,t,0)-V((0,0,.018)) for t in (.019,.23,.48,.72,1)]
        tube(g,'Cedar',rib,[.016,.015,.013,.011,.008],6)
        rod(g,'Cedar',(cx,cy,2.258),rib[2],.011,6)
        ellipse(g,'Brass',tuple(rib[-1]),(.015,.015,.018),6,3)
    spin(g,'Teak',(cx,cy),[(.06,2.851),(.057,2.902),(.044,2.911),(.045,2.929),(.032,2.948),(.009,2.964)],16)


def palm_tree(g):
    rng=random.Random(2371)
    # Wheel-thrown body with sixteen flutes, a turned foot, and a thick inward-rolled lip.
    prof=[(.615,0,0),(.629,.027,.002),(.622,.087,.003),(.624,.104,.008),
          (.657,.177,.017),(.699,.473,.022),(.697,.609,.012),(.696,.636,0),
          (.729,.651,0),(.739,.685,0),(.737,.715,0),(.715,.747,0),
          (.675,.749,0),(.661,.716,0),(.660,.651,0)]
    rings=[]
    for r,z,flute in prof:
        ring=[]
        for i in range(64):
            a=i*TAU/64
            rr=r+flute*math.cos(16*a)
            ring.append((rr*math.cos(a),rr*math.sin(a),z))
        rings.append(ring)
    loft(g,rings,['Umber_Glaze','Glazed_Clay','Ochre_Glaze','Glazed_Clay','Glazed_Clay',
                  'Glazed_Clay','Glazed_Clay','Ochre_Glaze','Glazed_Clay','Glazed_Clay',
                  'Ochre_Glaze','Ochre_Glaze','Glazed_Clay','Umber_Glaze'],closed=False)
    g.add(rings[0],[tuple(reversed(range(64)))],'Umber_Glaze')
    spin(g,'Earth',(0,0),[(.656,.665),(.657,.688),(.41,.708),(.15,.714)],32)
    for i in range(8):
        a=i*TAU/8+rng.uniform(-.21,.21)
        rr=rng.uniform(.34,.56)
        s=rng.uniform(.042,.077)
        with g.space((rr*math.cos(a),rr*math.sin(a),.700),(0,0,a)):
            ellipse(g,'Pebble' if i%3 else 'Stone_Shade',(0,0,0),(s,s*.69,s*.36),7,4)
    def center(t):
        return V((.10*math.sin(t*TAU-.2)+.45*t*t, -.16*math.sin(PI*t)+.11*t, .65+4.92*t))
    # Each leaf scar has a skewed shoulder and an undercut around the continuous stem.
    n,bands=12,22
    rings,mats=[],[]
    for j in range(bands):
        for f,lip,mat in [(0,.004,'Palm_Bark'),(.75,0,'Palm_Scar'),(.92,.015,'Bark_Shadow')]:
            t=(j+f)/bands
            c=center(t)
            r=.207*(1-t)+.096*t+.030*math.exp(-14*t)+lip*(1-.36*t)
            ring=[]
            for i in range(n):
                a=i*TAU/n+.075*math.sin(t*3.4)
                rr=r*(1+.029*math.sin(3*a+2*t)+.018*math.cos(5*a-t))
                tilt=(.024*math.sin(2*a+j*.18)+.012*math.cos(3*a-j*.11))*min(1,t*12)
                ring.append(c+V((rr*math.cos(a),rr*math.sin(a),tilt)))
            rings.append(ring)
            mats.append(mat)
    c=center(1)
    rings.append([c+V((.095*math.cos(i*TAU/n),.095*math.sin(i*TAU/n),0)) for i in range(n)])
    loft(g,rings,mats)
    ellipse(g,'Crown',c+V((0,0,.012)),(.18,.17,.225),13,6)
    for j in range(5):
        a=j*TAU/5+.24
        with g.space(c+V((.165*math.cos(a),.165*math.sin(a),-.112+.042*math.sin(2*a))),
                     (.23*math.sin(a),-.29*math.cos(a),a)):
            ellipse(g,'Coconut_Green' if j in (1,3) else 'Coconut',(0,0,0),(.122,.109,.154),10,5)
    # Both ranks carry individual lanceolate pinnae with a ridge, twist, and cut leaflet tips.
    for k in range(12):
        high=k%2
        angle=TAU*k/12+rng.uniform(-.092,.092)
        length=rng.uniform(1.71,1.96) if high else rng.uniform(1.86,2.19)
        sweep=rng.uniform(-.22,.22)
        rise=(2.16 if high else 1.26)+rng.uniform(-.14,.14)
        fall=(1.86 if high else 1.98)+rng.uniform(-.15,.16)
        base=c+V((0,0,-.010+.076*high))
        def rachis(t):
            a=angle+sweep*t
            return base+V((length*t*math.cos(a),length*t*math.sin(a),rise*t-fall*t*t))
        samples=[i/8 for i in range(9)]
        tube(g,'Leaf_Rib',[rachis(t) for t in samples],[.035*(1-t)**.76+.002 for t in samples],5)
        count=10+(k%3==0)
        for j in range(count):
            for side in (-1,1):
                t=.083+.862*(j+.19*(side>0))/count
                root=rachis(t)
                a=angle+sweep*t
                forward=V((math.cos(a),math.sin(a),0))
                across=V((-math.sin(a)*side,math.cos(a)*side,0))
                span=(.26+.52*math.sin(PI*t)**.68)*(1-.41*t)*rng.uniform(.89,1.09)
                point=forward*(.20+.25*t)+across*span
                blade_width=(.039+.046*math.sin(PI*t))*(1-.26*t)
                sideways=V((-point.y,point.x,0)).normalized()
                curl=rng.uniform(.19,.47)+.085*(1-high)
                def blade(s):
                    return root+point*s+forward*(.14*s*s)+V((0,0,.13*math.sin(PI*s)-curl*s*s))
                v=[root]
                for s,width in ((.29,1),(.67,.67)):
                    p=blade(s)
                    w=blade_width*width
                    v.extend([p-sideways*w+V((0,0,-w*.26)), p+V((0,0,w*.35)),
                              p+sideways*w+V((0,0,-w*.52))])
                p=blade(.83)
                v.extend([p-sideways*blade_width*.34,blade(.88)+sideways*blade_width*.048,
                          blade(1),p+sideways*blade_width*.33])
                faces=[(0,2,1),(0,3,2),(1,2,5,4),(2,3,6,5),(4,5,8,7),(5,6,10,8),(8,10,9)]
                # Vertex 8 cuts back into the leading edge like a wind-nicked palm leaflet.
                bright,dark=rng.choice([('Leaf_Light','Leaf_Jade'),('Leaf_Jade','Leaf_Emerald'),
                                         ('Leaf_Emerald','Leaf_Deep'),('Leaf_Sun','Leaf_Light')])
                g.add(v,faces,[bright,dark,bright,dark,bright,dark,dark],True)


def scoreboard_led(g):
    for x in (-1.32,1.32):
        box(g,'Rubber',(x,.015,.025),(.39,.73,.05),.046,steps=2)
        box(g,'Deep_Jade',(x,.015,.070),(.38,.71,.067),.039,steps=2)
        for y in (-.242,.246):
            rod(g,'Deep_Jade',(x,y,.09),(x,.02,.91),.052,8)
            rod(g,'Silver',(x-.055,y,.114),(x-.055,.017,.55),.014,6)
            spin(g,'Brass',(x+.105,y),[(.020,.103),(.020,.113)],6)
    rod(g,'Graphite',(-1.36,.11,.42),(1.36,.11,.42),.035)
    for j in range(4):
        x=-1.30+.65*j
        rod(g,'Deep_Jade',(x,.11,.43),(x+.325,.11,.64),.021,6)
        rod(g,'Deep_Jade',(x+.325,.11,.64),(x+.65,.11,.43),.021,6)
    box(g,'Graphite',(0,0,1.466),(3.765,.267,1.744),.064,.021,steps=3)
    box(g,'Deep_Jade',(0,-.125,1.441),(3.580,.070,1.613),.042,.010,steps=3)
    box(g,'Rubber',(0,-.152,1.426),(3.362,.035,1.501),.022,.007,steps=2)
    for s in (-1,1):
        x=s*1.821
        box(g,'Cedar',(x,-.087,1.463),(.096,.150,1.617),.022,.008,steps=3,grain=2)
        for z in (.731,2.174):
            rod(g,'Brass',(x,-.162,z),(x,-.168,z),.014,8)
    screen=[(-1.65,-.172,.701),(1.65,-.172,.701),(1.65,-.172,2.151),(-1.65,-.172,2.151)]
    # Blender's glTF exporter reverses V. The binary's top-left must be (0,1) for Three's canvas.
    g.add(screen,[(0,1,2,3)],'Court_Display',uvs=[[(0,1),(1,1),(1,0),(0,0)]],part='LED_Screen')
    box(g,'Deep_Jade',(0,-.143,2.235),(3.524,.037,.122),.012)
    with g.space((0,-.164,2.236),(PI/2,0,0)):
        type_mesh(g,'Porcelain','LAGOON OPEN',(0,0,0),.100,spacing=1.26)
        for x in (-.932,.932):
            box(g,'Brass',(x,0,.001),(.70,.008,.004),.002,bevel=0)
        for x in (-1.557,1.557):
            ellipse(g,'Gold_Paint',(x,0,.002),(.014,.014,.003),8,4)
    with g.space((0,-.086,2.332),(.115,0,0)):
        box(g,'Deep_Jade',(0,0,0),(3.82,.482,.050),.037,.009,steps=2)
        box(g,'Brass',(0,-.233,-.010),(3.72,.018,.018),.008)
    # Serviceable rear with louvres and accessible latch hardware.
    box(g,'Deep_Jade',(0,.143,1.53),(2.66,.039,1.16),.041,steps=2)
    for x in (-.96,.96):
        for j in range(5):
            box(g,'Graphite',(x,.177,1.39+.064*j),(.37,.041,.023),.009)
    for x in (-1.60,1.60):
        for z in (.84,2.09):
            box(g,'Silver',(x,.141,z),(.062,.022,.090),.012)
    tube(g,'Rubber',[(-1.0,.168,.993),(-1.0,.19,.72),(-1.07,.20,.54),(-1.22,.198,.47)],.018)


def pier_lantern(g):
    spin(g,'Iron',(0,0),[(.225,0),(.238,.023),(.238,.070),(.202,.092),(.190,.274),(.166,.30)],8,PI/8)
    box(g,'Pier_Timber',(0,0,1.728),(.263,.254,2.92),.030,.009,steps=1,grain=2)
    for z in (.31,.53,2.78,3.085):
        box(g,'Iron',(0,0,z),(.287,.277,.067),.030,.009)
        for sy in (-1,1):
            rod(g,'Brass',(0,sy*.136,z),(0,sy*.147,z),.016,8)
    spin(g,'Iron',(0,0),[(.176,3.16),(.193,3.18),(.188,3.205),(.153,3.23),(.145,3.245),
                           (.097,3.28),(.055,3.293)],8,PI/8)
    spin(g,'Brass',(0,0),[(.055,3.280),(.061,3.302),(.045,3.329),(.020,3.345),(.006,3.39)],12)
    end=(-.848,0,3.126)
    arch=bezier((-.11,0,3.105),(-.43,0,3.40),(-.79,0,3.405),end,16)
    tube(g,'Iron',arch,[.031-.010*i/16 for i in range(17)],9)
    brace=bezier((-.130,0,2.75),(-.35,0,2.75),(-.39,0,3.22),(-.57,0,3.286),12)
    tube(g,'Iron',brace,[.023-.005*i/12 for i in range(13)],8)
    scroll=bezier((-.21,0,2.805),(-.55,0,2.73),(-.60,0,3.062),(-.476,0,3.054),11)
    scroll+=bezier(scroll[-1],(-.393,0,3.052),(-.399,0,2.949),(-.452,0,2.960),7)[1:]
    tube(g,'Iron',scroll,[.017-.009*i/(len(scroll)-1) for i in range(len(scroll))],7)
    ellipse(g,'Brass',(-.451,0,2.960),(.018,.014,.018),8,4)
    x=-.848
    # The eye, bail and capped vent carry the glass cage on the scroll arm.
    for z,rx,rz in [(3.106,.038,.049),(3.028,.067,.064)]:
        tube(g,'Brass',[(x+rx*math.cos(i*TAU/16),0,z+rz*math.sin(i*TAU/16)) for i in range(16)],.009,6,loop=True)
    spin(g,'Iron',(x,0),[(.039,2.898),(.068,2.918),(.067,2.966),(.036,2.980),(.026,2.991)],12)
    spin(g,'Iron',(x,0),[(.244,2.728),(.267,2.748),(.271,2.766),(.210,2.801),(.076,2.921),(.042,2.931)],6,PI/6,smooth=False)
    spin(g,'Brass',(x,0),[(.270,2.747),(.273,2.756),(.266,2.765)],6,PI/6,smooth=False)
    spin(g,'Iron',(x,0),[(.025,2.030),(.048,2.049),(.055,2.091),(.125,2.115),
                           (.19,2.166),(.200,2.186),(.198,2.201)],6,PI/6,smooth=False)
    spin(g,'Lantern_Glass',(x,0),[(.180,2.202),(.224,2.724)],6,PI/6,smooth=False,closed=False)
    for i in range(6):
        a=PI/6+i*TAU/6
        def at(r,z):
            return (x+r*math.cos(a),r*math.sin(a),z)
        tube(g,'Iron',[at(.194,2.185),at(.188,2.215),at(.235,2.704),at(.246,2.742)],.014,7)
        rod(g,'Brass',at(.192,2.201),at(.199,2.278),.006,5)
    for r,z in [(.194,2.202),(.232,2.675)]:
        tube(g,'Brass',[(x+r*math.cos(PI/6+i*TAU/6),r*math.sin(PI/6+i*TAU/6),z) for i in range(6)],.008,6,loop=True)
    spin(g,'Brass',(x,0),[(.086,2.194),(.089,2.209),(.060,2.224),(.056,2.26),(.075,2.269)],14)
    spin(g,'Mat_LanternGlow',(x,0),[(.068,2.257),(.093,2.282),(.121,2.351),(.125,2.412),
                                    (.111,2.477),(.075,2.536),(.066,2.606),(.073,2.620)],18)
    spin(g,'Brass',(x,0),[(.075,2.615),(.077,2.628),(.058,2.637)],16)


def floodlight_tower(g):
    # Stadium floodlight tower aimed down -Y toward court center (9.6m tall).
    spin(g,'Concrete',(0,0),[(.46,0),(.48,.05),(.44,.42),(.38,.48)],8,PI/8,smooth=False)
    spin(g,'Iron',(0,0),[(.32,.48),(.33,.53),(.26,.54)],8,PI/8,smooth=False)
    for i in range(4):
        a = PI/4 + i*PI/2
        spin(g,'Brass',(.27*math.cos(a),.27*math.sin(a)),[(.026,.53),(.026,.575)],6,smooth=False)
    # Tapered octagonal mast with conduit, service door, and climbing rungs.
    spin(g,'Deep_Jade',(0,0),[(.21,.53),(.19,1.60),(.16,4.80),(.13,8.15),(.11,8.55)],8,PI/8,smooth=False)
    for z in (2.4,4.8,7.2):
        spin(g,'Silver',(0,0),[(.195-.016*z/2.4,z),(.205-.016*z/2.4,z+.09),(.195-.016*z/2.4,z+.11)],8,PI/8,smooth=False)
    box(g,'Graphite',(0,.185,1.25),(.16,.05,.46),.015)
    rod(g,'Silver',(.18,0,.55),(.13,0,8.10),.018,6)
    for k in range(14):
        z = 1.9 + k*.42
        s = 1 if k%2 else -1
        rod(g,'Iron',(s*.15,.08,z),(s*.27,.08,z),.012,5)
    # Maintenance service basket & guardrail near top of mast.
    box(g,'Iron',(0,.16,7.62),(.96,.58,.06),.025)
    for sx in (-1,1):
        rod(g,'Silver',(sx*.44,-.10,7.65),(sx*.44,-.10,8.42),.018,6)
        rod(g,'Silver',(sx*.44,.42,7.65),(sx*.44,.42,8.42),.018,6)
        rod(g,'Deep_Jade',(sx*.12,0,7.55),(sx*1.12,-.18,8.52),.036,8)
    rim(g,'Silver',(0,.16,8.40),.92,.54,.06,.016,6,2)
    # Twin-tier floodlight cross-arm bank pitched 24 deg downward toward -Y.
    with g.space((0,-.16,8.76),(-.42,0,0)):
        box(g,'Deep_Jade',(0,.12,.04),(2.78,.14,.12),.02)
        box(g,'Deep_Jade',(0,.12,.68),(2.58,.14,.12),.02)
        for sx in (-1.12,0,1.12):
            rod(g,'Silver',(sx,.12,-.04),(sx,.12,.76),.030,8)
        for row_z in (.04,.68):
            for x in (-1.04,-.35,.35,1.04):
                # U-yoke bracket + finned housing + anti-glare hood + proud glowing LED face.
                rod(g,'Silver',(x,.12,row_z),(x,-.02,row_z),.022,6)
                box(g,'Graphite',(x,-.05,row_z),(.54,.22,.36),.032,.012,steps=2)
                for fin in range(-2,3):
                    box(g,'Iron',(x+fin*.10,.085,row_z),(.022,.05,.30),.005)
                box(g,'Deep_Jade',(x,-.155,row_z),(.56,.06,.38),.025,.01)
                box(g,'Deep_Jade',(x,-.25,row_z+.18),(.56,.18,.025),.01)
                box(g,'Mat_FloodGlow',(x,-.195,row_z),(.47,.035,.29),.015,.004)
    # Top lightning arrestor & aviation beacon.
    rod(g,'Silver',(0,0,8.52),(0,0,9.58),.016,6)
    ellipse(g,'Coral',(0,0,9.58),(.055,.055,.075),10,5)


def sailboat(g):
    # Classic 5.6m coastal day-sailer, bow pointing down -Y, waterline at Z=0.
    stations = [
        (-2.85, .01, .02, .42, .45),
        (-2.25, .36, -.12, .12, .44),
        (-1.20, .74, -.24, .06, .43),
        ( .00, .92, -.28, .05, .42),
        (1.25, .84, -.24, .06, .44),
        (2.25, .62, -.12, .08, .48),
        (2.70, .44,  .04, .12, .51),
    ]
    lower_rings, stripe_rings, upper_rings = [], [], []
    for y, beam, keel_z, wl_z, sheer_z in stations:
        def sec(z_a, z_b, s_a, s_b):
            pts = []
            for k in range(9):
                u = k/8
                ang = -PI/2 + u*PI
                # Symmetric cross-section from port to keel to starboard.
                pass
            return pts
        # Build clean closed hull cross-section rings around the boat lengthwise.
        w_bot = beam * .24
        w_mid = beam * .86
        w_top = beam
        lower_rings.append([
            (-w_mid, y, wl_z-.05), (-w_bot, y, keel_z+.04), (0, y, keel_z),
            (w_bot, y, keel_z+.04), (w_mid, y, wl_z-.05), (w_mid*.94, y, wl_z-.05),
            (0, y, wl_z-.05), (-w_mid*.94, y, wl_z-.05)
        ])
        stripe_rings.append([
            (-w_mid*1.02, y, wl_z-.05), (w_mid*1.02, y, wl_z-.05),
            (w_mid*1.06, y, wl_z+.05), (-w_mid*1.06, y, wl_z+.05)
        ])
        upper_rings.append([
            (-w_mid*1.04, y, wl_z+.04), (w_mid*1.04, y, wl_z+.04),
            (w_top, y, sheer_z), (w_top*.88, y, sheer_z+.03),
            (-w_top*.88, y, sheer_z+.03), (-w_top, y, sheer_z)
        ])
    loft(g, lower_rings, 'Antifoul', closed=True)
    loft(g, stripe_rings, 'Coral', closed=True)
    loft(g, upper_rings, 'Hull_White', closed=True)

    # Teak foredeck, rub-rail, recessed cockpit benches, and rudder/tiller.
    box(g,'Teak',(0,.15,.44),(1.52,4.40,.06),.45,steps=3,grain=1)
    box(g,'Hull_White',(0,-.75,.64),(1.08,1.72,.38),.26,.04,steps=3)
    box(g,'Teak',(0,-.88,.84),(.56,.54,.05),.05,grain=1)
    for sx in (-1,1):
        for py in (-1.05,-.45):
            with g.space((sx*.54,py,.64),(0,sx*PI/2,0)):
                spin(g,'Brass',(0,0),[(.095,0),(.095,.022),(.074,.025)],12)
                spin(g,'Ink',(0,0),[(.072,.015),(.072,.024)],12)
        box(g,'Teak',(sx*.52,1.15,.54),(.32,1.68,.12),.04,grain=1)
    box(g,'Teak',(0,1.25,.40),(.76,1.62,.05),.05,grain=1)
    # Curved mahogany tiller & transom rudder.
    box(g,'Teak',(0,2.76,.14),(.06,.26,.68),.02,grain=2)
    tube(g,'Cedar',[(0,2.68,.55),(0,2.30,.64),(0,1.78,.68)],.028,7)
    # Fin keel under waterline for silhouette integrity if seen rolling.
    box(g,'Antifoul',(0,.10,-.58),(.09,.95,.68),.03)

    # Mast, spreaders, boom, standing stays, and billowing cambered sails.
    spin(g,'Cedar',(0,-.45),[(.058,.45),(.046,3.20),(.030,5.55)],12,grain=2)
    for sx in (-1,1):
        rod(g,'Silver',(0,-.45,3.35),(sx*.64,-.42,3.44),.014,6)
        rod(g,'Silver',(sx*.84,-.38,.46),(sx*.64,-.42,3.44),.008,5)
        rod(g,'Silver',(sx*.64,-.42,3.44),(0,-.45,5.35),.008,5)
    rod(g,'Silver',(0,-2.72,.46),(0,-.45,5.38),.009,5)
    rod(g,'Silver',(0,2.62,.51),(0,-.45,5.48),.008,5)
    rod(g,'Cedar',(0,-.42,1.24),(0,2.18,1.28),.038,10)

    # Cambered mainsail (Sail_Ivory + Sail_Honey reef band)
    nu, nv = 10, 14
    main_v = []
    for j in range(nv+1):
        v = j/nv
        z = 1.28 + (5.34-1.28)*v
        y_luff = -.39
        y_leech = 2.15*(1-v) - .35*v + .18*math.sin(PI*v)
        for i in range(nu+1):
            u = i/nu
            y = y_luff + (y_leech-y_luff)*u
            belly = .42*math.sin(PI*u)*(1-.45*v)*math.sin(PI*(.12+.84*v))
            main_v.append((belly, y, z))
    main_f, main_m = [], []
    for j in range(nv):
        for i in range(nu):
            a = j*(nu+1)+i
            main_f.append((a, a+1, a+nu+2, a+nu+1))
            main_m.append('Sail_Honey' if j in (4,5) else 'Sail_Ivory')
    g.add(main_v, main_f, main_m, True)

    # Cambered jib foresail
    jib_v = []
    for j in range(11):
        v = j/10
        z = .72 + (5.24-.72)*v
        y_fore = -2.62*(1-v) - .48*v
        y_aft = -.60*(1-v) - .46*v
        for i in range(7):
            u = i/6
            y = y_fore + (y_aft-y_fore)*u
            belly = .26*math.sin(PI*u)*(1-.40*v)*math.sin(PI*(.15+.80*v))
            jib_v.append((belly, y, z))
    jib_f = [(j*7+i, j*7+i+1, (j+1)*7+i+1, (j+1)*7+i) for j in range(10) for i in range(6)]
    g.add(jib_v, jib_f, 'Sail_Ivory', True)

    # Fluttering coral masthead pennant
    pen = [(0,-.45,5.50),(0,-.45,5.60),(.08,.22,5.57),(.14,.55,5.55),(.08,.22,5.52)]
    g.add(pen, [(0,1,2,4),(4,2,3)], 'Coral', True)


def lighthouse(g):
    # Majestic 14.6m striped coastal lighthouse; foundation extends to Z=-0.6m for island slope.
    spin(g,'Masonry',(0,0),[(2.55,-.65),(2.50,0),(2.42,1.15),(2.22,1.38)],12,PI/12,smooth=False)
    spin(g,'Stone_Light',(0,0),[(2.26,1.36),(2.26,1.52),(2.06,1.58)],16,smooth=False)
    # Keeper's arched stone doorway on -Y elevation.
    box(g,'Stone_Warm',(0,-2.12,.72),(1.16,.55,1.46),.06)
    box(g,'Pier_Timber',(0,-2.36,.68),(.74,.14,1.22),.03,grain=2)
    ellipse(g,'Brass',(.22,-2.44,.65),(.035,.045,.035),8,4)
    # Tapered tower shaft in crisp alternating Limewash & Signal_Red stripes.
    bands = [
        (1.56, 2.04, 3.35, 1.88, 'Limewash'),
        (3.35, 1.88, 5.15, 1.72, 'Signal_Red'),
        (5.15, 1.72, 7.00, 1.56, 'Limewash'),
        (7.00, 1.56, 8.85, 1.42, 'Signal_Red'),
        (8.85, 1.42, 10.58, 1.30, 'Limewash'),
    ]
    for z0, r0, z1, r1, mat in bands:
        spin(g, mat, (0,0), [(r0,z0),(r1,z1)], 28, closed=False)
    # Spiral watch-tower windows with stone sills.
    for z, a in [(3.8, -.4), (6.2, .35), (8.4, -.55)]:
        r = 2.04 - (z-1.56)*(.74/9.02)
        with g.space((r*math.sin(a), -r*math.cos(a), z), (0, 0, a)):
            box(g,'Stone_Light',(0,-.06,-.34),(.58,.24,.10),.02)
            box(g,'Stone_Shade',(0,-.02,0),(.52,.16,.66),.03)
            box(g,'Ink',(0,-.08,0),(.36,.08,.52),.01)
    # Corbeled stone gallery deck & wrought-iron parapet railing.
    spin(g,'Stone_Warm',(0,0),[(1.30,10.48),(1.48,10.72),(1.76,10.95),(1.92,11.08),(1.92,11.24),(1.82,11.28)],24)
    for i in range(16):
        a = i*TAU/16
        rx, ry = 1.78*math.cos(a), 1.78*math.sin(a)
        rod(g,'Iron',(rx,ry,11.24),(rx,ry,12.14),.028,6)
    for rz in (11.68, 12.14):
        tube(g,'Iron',arc_points(0,0,rz,1.78,24),.032,7,loop=True)
    # Glazed decagonal lantern room with glowing Fresnel lens core.
    spin(g,'Iron',(0,0),[(1.28,11.24),(1.30,11.78),(1.24,11.82)],20)
    spin(g,'Lantern_Glass',(0,0),[(1.18,11.82),(1.18,13.06)],12,smooth=False,closed=False)
    for i in range(12):
        a = i*TAU/12
        rod(g,'Iron',(1.21*math.cos(a),1.21*math.sin(a),11.78),
            (1.21*math.cos(a),1.21*math.sin(a),13.10),.032,6)
    # Multi-tiered glowing Fresnel beacon inside lantern room.
    spin(g,'Brass',(0,0),[(.68,11.78),(.74,11.90),(.52,11.98)],18)
    spin(g,'Mat_LampGlow',(0,0),[(.56,11.98),(.66,12.22),(.70,12.46),(.66,12.70),(.54,12.90)],22)
    for z in (12.18, 12.46, 12.74):
        tube(g,'Brass',arc_points(0,0,z,.70,20),.022,6,loop=True)
    # Ribbed copper cupola roof, vent ball, and lightning finial.
    spin(g,'Iron',(0,0),[(1.30,13.06),(1.42,13.14),(1.36,13.22)],20)
    spin(g,'Copper',(0,0),[(1.34,13.20),(1.22,13.45),(.96,13.74),(.56,13.98),(.18,14.12)],24)
    spin(g,'Brass',(0,0),[(.18,14.10),(.24,14.24),(.22,14.38),(.10,14.48),(.03,14.66),(.01,14.92)],14)


def ball_basket(g):
    # Pro courtside wheeled tennis ball teaching hopper (~0.88m tall) brimming with tennis balls.
    rng = random.Random(409)
    # 4 swivel rubber caster wheels sitting cleanly on Z=0.
    for sx in (-.21, .21):
        for sy in (-.18, .18):
            with g.space((sx,sy,.038),(0,PI/2,0)):
                spin(g,'Rubber',(0,0),[(.038,-.014),(.038,.014)],12)
                spin(g,'Brass',(0,0),[(.014,-.017),(.014,.017)],8)
            box(g,'Silver',(sx,sy,.062),(.032,.042,.048),.008)
    # Folding X-frame tubular chassis & lower shelf bars.
    for sy in (-.18,.18):
        rod(g,'Deep_Jade',(-.21,sy,.08),(.21,sy,.50),.013,8)
        rod(g,'Deep_Jade',(.21,sy,.08),(-.21,sy,.50),.013,8)
        rod(g,'Silver',(-.20,sy,.12),(.20,sy,.12),.010,6)
    rod(g,'Silver',(-.20,-.18,.12),(-.20,.18,.12),.010,6)
    rod(g,'Silver',(.20,-.18,.12),(.20,.18,.12),.010,6)
    rod(g,'Brass',(0,-.185,.29),(0,.185,.29),.012,8)
    # Wire-grid basket (Z = 0.48..0.82)
    bw, bd = .46, .38
    for z in (.48, .59, .70, .81):
        rim(g,'Silver',(0,0,z),bw,bd,.045,.0065,6,2)
    for x in (-.20,-.12,-.04,.04,.12,.20):
        for sy in (-1,1):
            rod(g,'Silver',(x,sy*bd/2,.48),(x,sy*bd/2,.81),.0045,5)
        rod(g,'Silver',(x,-bd/2,.48),(x,bd/2,.48),.0045,5)
    for y in (-.15,-.075,0,.075,.15):
        for sx in (-1,1):
            rod(g,'Silver',(sx*bw/2,y,.48),(sx*bw/2,y,.81),.0045,5)
        rod(g,'Silver',(-bw/2,y,.48),(bw/2,y,.48),.0045,5)
    # Curved push handle with rubber comfort grip & club nameplate.
    tube(g,'Deep_Jade',[(-.22,.19,.49),(-.22,.23,.82),(-.14,.25,.89),
                        (.14,.25,.89),(.22,.23,.82),(.22,.19,.49)],.011,8)
    rod(g,'Rubber',(-.11,.25,.89),(.11,.25,.89),.016,8)
    box(g,'Deep_Jade',(0,-.195,.75),(.16,.012,.065),.01)
    box(g,'Gold_Paint',(0,-.202,.75),(.12,.004,.032),.005)
    # 38 optic-yellow tennis balls piled naturally inside the hopper.
    layers = [
        (.525, 4, 3, .095, .095),
        (.598, 4, 3, .094, .094),
        (.672, 4, 3, .094, .092),
        (.745, 3, 2, .105, .102),
    ]
    for lz, nx, ny, sx, sy in layers:
        for ix in range(nx):
            for iy in range(ny):
                bx = (ix-(nx-1)/2)*sx + rng.uniform(-.012,.012)
                by = (iy-(ny-1)/2)*sy + rng.uniform(-.012,.012)
                bz = lz + rng.uniform(-.006,.012) + (.018 if lz > .70 and ix == 1 else 0)
                mat = 'Ball_Sun' if rng.random() < .45 else 'Ball_Felt'
                ellipse(g, mat, (bx,by,bz), (.036,.036,.036), 10, 5)
                # Subtle white seam band on top-layer balls
                if lz > .65:
                    a = rng.uniform(0, PI)
                    with g.space((bx,by,bz), (a, rng.uniform(-.5,.5), rng.uniform(0,TAU))):
                        tube(g,'Ball_Seam',[(.0365*math.cos(t),.0365*math.sin(t),.006*math.sin(2*t))
                                            for t in [k*TAU/12 for k in range(12)]],.0022,4,loop=True)


PROPS = [
    ("umpire_chair", umpire_chair),
    ("bench_umbrella", bench_umbrella),
    ("palm_tree", palm_tree),
    ("scoreboard_led", scoreboard_led),
    ("pier_lantern", pier_lantern),
    ("floodlight_tower", floodlight_tower),
    ("sailboat", sailboat),
    ("lighthouse", lighthouse),
    ("ball_basket", ball_basket),
]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATERIALS.clear()
    WOOD.clear()
    FONTS.clear()


def export_glb(objs, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        use_selection=True,
    )
    data = path.read_bytes()
    chunk_len = struct.unpack_from("<I", data, 12)[0]
    meta = json.loads(data[20:20 + chunk_len].decode("utf-8"))
    nodes = [n.get("name") for n in meta.get("nodes", [])]
    mats = [m.get("name") for m in meta.get("materials", [])]
    print(f"[GLB] {path.name}: {len(data)/1024:.1f} KB | meshes={len(meta.get('meshes',[]))} | mats={len(mats)}")
    return nodes, mats


def setup_cycles(res=(1440, 820), samples=22):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 6
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("PropStudio")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.52, 0.75, 0.86, 1.0)
    bg.inputs["Strength"].default_value = 0.80

    sun_d = bpy.data.lights.new("Sun", type="SUN")
    sun_d.energy = 3.6
    sun_d.color = (1.0, 0.94, 0.84)
    sun = bpy.data.objects.new("Sun", sun_d)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (0.76, 0.14, 0.56)

    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, 0))
    fl = bpy.context.active_object
    fmat = material("StudioGround", "E4DAC6", .85)
    fl.data.materials.append(fmat)


def render_sheet(items, out_path, cam_loc, target, folder):
    clear_scene()
    palette(folder)
    for name, fn, loc, rot_z in items:
        g = Geometry(name)
        with g.space(loc, (0, 0, rot_z)):
            fn(g)
        g.finish()
    setup_cycles((1440, 820), samples=22)
    cd = bpy.data.cameras.new("Cam")
    cd.lens = 42
    co = bpy.data.objects.new("Cam", cd)
    bpy.context.scene.collection.objects.link(co)
    co.location = V(cam_loc)
    co.rotation_euler = (V(target) - V(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = co
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)


def main():
    with tempfile.TemporaryDirectory() as tmp_str:
        folder = Path(tmp_str)
        # 1. Export all 9 props individually with clean materials
        for name, fn in PROPS:
            clear_scene()
            palette(folder)
            g = Geometry(name)
            fn(g)
            objs = g.finish()
            nodes, mats = export_glb(objs, OUTPUT / f"{name}.glb")
            if name == "scoreboard_led":
                assert "LED_Screen" in nodes, f"LED_Screen missing in {nodes}"
            elif name == "bench_umbrella":
                assert "Mat_CanopyA" in mats and "Mat_CanopyB" in mats, f"Canopy mats missing: {mats}"
            elif name == "pier_lantern":
                assert "Mat_LanternGlow" in mats, f"Mat_LanternGlow missing: {mats}"
            elif name == "floodlight_tower":
                assert "Mat_FloodGlow" in mats, f"Mat_FloodGlow missing: {mats}"
            elif name == "lighthouse":
                assert "Mat_LampGlow" in mats, f"Mat_LampGlow missing: {mats}"

        # 2. Render Courtside Props lineup (Cycles CPU)
        render_sheet(
            [
                ("umpire_chair", umpire_chair, (-4.3, 0.0, 0.0), -PI/2 + .35),
                ("bench_umbrella", bench_umbrella, (-1.3, 0.3, 0.0), PI/2 - .20),
                ("scoreboard_led", scoreboard_led, (2.5, 0.2, 0.0), -.18),
                ("pier_lantern", pier_lantern, (5.5, 0.0, 0.0), .25),
                ("ball_basket", ball_basket, (0.3, -1.5, 0.0), -.35),
            ],
            PREVIEWS / "props_courtside.png",
            (0.6, -13.2, 3.6),
            (0.6, 0.0, 1.45),
            folder,
        )

        # 3. Render Environment Hero Props lineup (Cycles CPU)
        render_sheet(
            [
                ("palm_tree", palm_tree, (-9.4, 0.0, 0.0), .4),
                ("floodlight_tower", floodlight_tower, (-3.4, 0.0, 0.0), .22),
                ("sailboat", sailboat, (2.8, -0.5, 0.4), -.85),
                ("lighthouse", lighthouse, (9.8, 0.5, 0.6), -.25),
            ],
            PREVIEWS / "props_environment.png",
            (0.4, -31.5, 8.6),
            (0.4, 0.0, 6.4),
            folder,
        )

    print("[OK] All 9 props exported and rendered cleanly.")


if __name__ == "__main__":
    main()
