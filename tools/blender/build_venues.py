"""Build the Lagoon Open venue GLBs and photograph them in a Cycles CPU studio.

Run with Blender 5.3 in background mode. Geometry is authored in metres, with
the courtside elevation looking down -Y. Each surface finish is one draw call.
"""

from array import array
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
import json
from math import atan2, ceil, cos, floor, pi, sin, sqrt, tau
from pathlib import Path
import random
import struct

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public/models/venues"
PREVIEWS = ROOT / "tools/blender/previews/venues"
LAMP = "Mat_VenueLampGlow"


# The hex swatches are artist-facing sRGB. Blender handles the transfer to
# scene-linear RGB for lighting and the glTF COLOR_0 attribute.
@dataclass(frozen=True)
class Pigment:
    finish: str
    hex: str


def palette(finish, colors):
    return tuple(Pigment(finish, color) for color in colors.split())


# Roughness, metalness, and two-sidedness. The two folded botanical surfaces
# and the woven canvas are intentionally two-sided.
FINISHES = {
    "Mat_CutStone": (.82, 0, False),
    "Mat_Limewash": (.89, 0, False),
    "Mat_Timber": (.69, 0, False),
    "Mat_FiredClay": (.50, 0, False),
    "Mat_GlazedTile": (.28, .05, False),
    "Mat_Metalwork": (.36, .72, False),
    "Mat_Leaves": (.68, 0, True),
    "Mat_Bracts": (.64, 0, True),
    "Mat_Joinery": (.49, 0, False),
    "Mat_Shingles": (.85, 0, False),
    "Mat_Canvas": (.92, 0, True),
    "Mat_WindowGlass": (.24, .22, False),
    LAMP: (.24, .04, False),
}
STONE = palette("Mat_CutStone", "c79472 d4a783 e2b790 ecc69d f1d4ad")
ROSE, OCHRE, PEACH = palette("Mat_Limewash", "d58b71 b97961 e7a284")
CEDAR = palette("Mat_Timber", "694b3b 805b46 936c50 a67d5d b48c69")
POT, POT_LIGHT, POT_DARK, SLIP = palette("Mat_FiredClay", "b96244 d57d54 85422f f5cb9d")
TILE, AQUA, HONEY = palette("Mat_GlazedTile", "386d70 79aaa1 d9a554")
IRON, BRONZE, GOLD, COPPER, PATINA = palette("Mat_Metalwork", "3c4241 805c39 c49950 b77755 628a7a")
VINE, TWIG = palette("Mat_Timber", "654734 937253")
GREENERY = palette("Mat_Leaves", "205342 317052 438359 57925d 739e61 93ad72")
FLOWERS = palette("Mat_Bracts", "9e2053 cb2467 e7397d fb598d fd817e f36b58 f9c398")
PALM = palette("Mat_Leaves", "477f69 66977d 82aa88 a6b998")
WHITE, IVORY, MILK, SHADOW, FOREST, JADE, SAGE = palette(
    "Mat_Joinery", "f4e9ce e7dcc1 fbf3dc c0bba4 214f47 336858 6e8b77")
SIDING, SIDING_SHADE = palette("Mat_Limewash", "ead8b4 c5b99d")
SHAKES = palette("Mat_Shingles", "687672 72807c 7a8681 808b83 899087 78827c")
CLOTH = palette("Mat_Canvas", "226450 2b715c f5e6c6 fbeed3")
GLASS, SEA_GLASS = palette("Mat_WindowGlass", "456c70 68908d")
LIT, AMBER = palette(LAMP, "c3b99a ffd297")
BOXWOOD = palette("Mat_Leaves", "215747 2c654b 397452 478252 61905a 7fa062")


@lru_cache(maxsize=None)
def rgba(hex_value):
    return tuple(int(hex_value[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (1.,)


def linear_rgba(hex_value):
    def channel(s):
        return s / 12.92 if s <= .04045 else ((s + .055) / 1.055) ** 2.4
    return tuple(channel(s) for s in rgba(hex_value)[:3]) + (1.,)


def new_material(name, glow):
    rough, metal, two_sided = FINISHES[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not two_sided
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = rough
    shader.inputs["Metallic"].default_value = metal
    color = mat.node_tree.nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Pigment"
    mat.node_tree.links.new(color.outputs["Color"], shader.inputs["Base Color"])
    if name == LAMP:
        shader.inputs["Emission Color"].default_value = linear_rgba("ffd399")
        shader.inputs["Emission Strength"].default_value = glow
    return mat


@dataclass
class Batch:
    vertices: list = field(default_factory=list)
    faces: list = field(default_factory=list)
    colors: array = field(default_factory=lambda: array("f"))
    smooth: list = field(default_factory=list)


class Model:
    def __init__(self, seed):
        self.parts = defaultdict(Batch)
        self.rng = random.Random(seed)

    def add(self, paint, vertices, faces, smooth=False):
        part = self.parts[paint.finish]
        offset = len(part.vertices)
        part.vertices.extend(tuple(v) for v in vertices)
        part.colors.extend(rgba(paint.hex) * len(vertices))
        part.faces.extend(tuple(offset + i for i in face) for face in faces)
        part.smooth.extend([smooth] * len(faces) if isinstance(smooth, bool) else smooth)

    def objects(self, glow):
        result = []
        for name, part in self.parts.items():
            mesh = bpy.data.meshes.new(name.removeprefix("Mat_"))
            mesh.from_pydata(part.vertices, [], part.faces)
            mesh.polygons.foreach_set("use_smooth", part.smooth)
            color = mesh.color_attributes.new(name="Pigment", type="BYTE_COLOR", domain="POINT")
            color.data.foreach_set("color_srgb", part.colors)
            mesh.color_attributes.active_color = color
            mesh.materials.append(new_material(name, glow))
            mesh.update()
            obj = bpy.data.objects.new(mesh.name, mesh)
            bpy.context.scene.collection.objects.link(obj)
            result.append(obj)
        return result


def loft(m, paint, rings, smooth=False, caps=True):
    n = len(rings[0])
    faces = []
    for row in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            a, b = row * n, (row + 1) * n
            faces.append((a + i, a + j, b + j, b + i))
    flags = [smooth] * len(faces)
    if caps:
        faces.extend([tuple(reversed(range(n))), tuple(range((len(rings) - 1) * n, len(rings) * n))])
        flags.extend([False, False])
    m.add(paint, [v for ring in rings for v in ring], faces, flags)


def rect_ring(x, y, z, w, d, cut=0):
    a, b = w / 2, d / 2
    if cut:
        c = min(cut, a * .8, b * .8)
        offsets = [(-a+c,-b),(a-c,-b),(a,-b+c),(a,b-c),
                   (a-c,b),(-a+c,b),(-a,b-c),(-a,-b+c)]
    else:
        offsets = [(-a,-b),(a,-b),(a,b),(-a,b)]
    return [(x + i, y + j, z) for i, j in offsets]


def molding(m, paint, x, y, sections, cut=0):
    loft(m, paint, [rect_ring(x, y, z, w, d, cut) for z, w, d in sections])


def box(m, paint, x, y, z0, z1, w, d):
    molding(m, paint, x, y, [(z0, w, d), (z1, w, d)])


def lip(m, paint, x, y, z0, z1, w, d, bevel, cut=0):
    molding(m, paint, x, y, [(z0, w-2*bevel, d-2*bevel),
                              (z0+bevel, w, d), (z1-bevel, w, d),
                              (z1, w-2*bevel, d-2*bevel)], cut)


def lathe(m, paint, x, y, profile, sides=12, smooth=True, angle=0, caps=True):
    rings = [[(x+r*cos(angle+tau*i/sides), y+r*sin(angle+tau*i/sides), z)
              for i in range(sides)] for z, r in profile]
    loft(m, paint, rings, smooth, caps)


def extrude(m, paint, points, start, end, plane="XZ"):
    """Extrude a simple CCW outline. The XZ front faces -Y, the YZ front +X."""
    area = sum(a[0]*b[1] - a[1]*b[0] for a, b in zip(points, points[1:]+points[:1]))
    if area < 0:
        points = list(reversed(points))
    n = len(points)
    faces = [tuple(range(n)), tuple(reversed(range(n, 2*n)))]
    faces.extend((i, n+i, n+(i+1)%n, (i+1)%n) for i in range(n))
    if plane == "XZ":
        vertices = [(a, t, b) for t in (start, end) for a, b in points]
    else:
        vertices = [(t, a, b) for t in (end, start) for a, b in points]
    m.add(paint, vertices, faces)


def tube(m, paint, points, radii, sides=6, smooth=True):
    path = [Vector(point) for point in points]
    if isinstance(radii, (int, float)):
        radii = [radii] * len(path)
    rings = []
    across = None
    for i, (p, radius) in enumerate(zip(path, radii)):
        tangent = (path[min(i+1, len(path)-1)] - path[max(0, i-1)]).normalized()
        if across is None:
            across = tangent.cross(Vector((0, 0, 1) if abs(tangent.z) < .9 else (0, 1, 0)))
        across = (across - tangent * across.dot(tangent)).normalized()
        other = tangent.cross(across)
        rings.append([p + radius*(across*cos(tau*j/sides) + other*sin(tau*j/sides))
                      for j in range(sides)])
    loft(m, paint, rings, smooth)


def beam(m, paint, a, b, width, depth):
    a, b = Vector(a), Vector(b)
    along = (b-a).normalized()
    u = along.cross(Vector((0,0,1) if abs(along.z) < .98 else (0,1,0))).normalized()
    v = along.cross(u)
    rings = [[p + u*(s*width/2) + v*(t*depth/2)
              for s,t in [(-1,-1),(1,-1),(1,1),(-1,1)]] for p in (a,b)]
    loft(m, paint, rings)


def arc_band(m, paint, x, z, inner, outer, angle0, angle1, front, back, steps):
    def pt(r, t):
        return x + r[0]*cos(t), z + r[1]*sin(t)
    # Independent quad strips keep the long concave archivolts well conditioned.
    rings = []
    for i in range(steps+1):
        t = angle0 + (angle1-angle0)*i/steps
        ix, iz = pt(inner, t)
        ox, oz = pt(outer, t)
        rings.append([(ix,front,iz),(ox,front,oz),(ox,back,oz),(ix,back,iz)])
    loft(m, paint, rings)


def folded_leaf(m, paint, root, tip, width, ridge, side=None):
    root, tip = Vector(root), Vector(tip)
    axis = (tip-root).normalized()
    side = Vector(side) if side is not None else axis.cross(Vector((0,-1,.6)))
    side = (side-axis*axis.dot(side)).normalized()
    if side.length_squared < .001:
        side = axis.orthogonal().normalized()
    mid = root.lerp(tip, .53)
    m.add(paint, [root, mid-side*width, mid+Vector(ridge), mid+side*width, tip],
          [(0,1,2),(0,2,3),(1,4,2),(2,4,3)])


def terrace(m):
    lip(m, STONE[1], 0, 0, 0, .15, 18.0, 3.2, .025, .12)
    # Lay the two risers in staggered ashlar, with a recessed mortar core.
    for z0, z1, w, d, offset in [(.15,.32,17.78,3.01,.42),(.36,.56,17.46,2.72,.03)]:
        box(m, OCHRE, 0, 0, z0, z1, w-.05, d-.06)
        x = -w/2
        first = True
        while x < w/2-.02:
            length = min(w/2-x, m.rng.uniform(.82, 1.26) if not first else .6+offset)
            box(m, m.rng.choice(STONE[:3]), x+length/2, 0, z0+.006, z1,
                length-.012, d)
            first = False
            x += length
    lip(m, STONE[3], 0, 0, .31, .375, 17.81, 3.035, .013, .085)
    lip(m, STONE[4], 0, 0, .55, .65, 17.59, 2.87, .023, .08)
    # A short hand-set glazed lozenge frieze just under the top coping.
    for center in (-5.27, 0, 5.27):
        for face in (-1, 1):
            y = face*1.374
            box(m, TILE, center, y, .409, .502, 2.28, .018)
            for i in range(-5, 6):
                x = center+i*.198
                extrude(m, AQUA if i % 2 else HONEY,
                        [(x-.075,.455),(x,.484),(x+.075,.455),(x,.425)],
                        y-.013, y+.013)


def limestone_column(m, x):
    y = -.02
    lip(m, STONE[1], x,y,.65,.77,1.12,1.14,.026,.07)
    molding(m, STONE[3], x,y,[(.77,1.03,1.05),(.82,1.03,1.05),(.87,.91,.93),(.94,.88,.9)],.065)
    molding(m, STONE[2], x,y,[(.94,.85,.88),(1.04,.83,.86),(1.91,.745,.80)],.105)
    for face in (-1, 1):
        for dx in (-.20, 0, .20):
            # The tapered recessed reeds follow the entasis on both elevations.
            y0, y1 = y+face*.437, y+face*.406
            m.add(STONE[1], [(x+dx-.019,y0,1.04),(x+dx+.019,y0,1.04),
                             (x+dx+.013,y1,1.85),(x+dx-.013,y1,1.85)],
                  [(0,1,2,3) if face < 0 else (3,2,1,0)])
    molding(m, STONE[4], x,y,[(1.88,.79,.85),(1.935,.88,.91),(1.975,.88,.91),
                               (2.045,1.055,1.05),(2.10,1.055,1.05)],.065)
    lip(m, STONE[3], x,y,2.085,2.18,1.14,1.13,.018,.045)


def shell_relief(m, x, y, z, size, face):
    # A fluted scallop in low relief. Each rib casts its own fine shadow.
    pivot = (x, y, z)
    for i in range(7):
        t = (.13 + .74*i/6)*pi
        dx, dz = size*cos(t), size*(.74+.26*sin(t))*sin(t)
        tube(m, STONE[4], [pivot,(x+.68*dx,y+face*.017,z+.70*dz),
                            (x+dx,y,z+dz)], [.011,.021,.012], 5)


def stone_arch(m, left, right, central):
    x, half = (left+right)/2, (right-left)/2
    z = 2.145
    rx, rz = half-.39, (4.30 if central else 3.53)-z
    top = 4.70 if central else 4.055
    n = 15 if central else 11
    angles = [pi-pi*i/(2*n) for i in range(2*n+1)]
    soffit = [(x-half,z)] + [(x+(rx+.025)*cos(t),z+(rz+.023)*sin(t)) for t in angles] + [(x+half,z)]
    # One continuous pierced wall, faced on both sides in individual stones.
    for (a, za), (b, zb) in zip(soffit, soffit[1:]):
        extrude(m, ROSE, [(a,za),(b,zb),(b,top),(a,top)], -.432,.395)
    for j in range(n):
        key = j == n//2
        t0, t1 = j*pi/n+.006, (j+1)*pi/n-.006
        inner = (rx-.045*key, rz-.085*key)
        outer = (rx+.31+.035*key, rz+.315+.073*key)
        front = -.585 if key else -.512-m.rng.uniform(0,.015)
        arc_band(m, STONE[4] if key else m.rng.choice(STONE[1:4]),
                 x,z,inner,outer,t0,t1,front,.50 if key else .455,2)
    arc_band(m, STONE[3], x,z,(rx+.303,rz+.30),(rx+.365,rz+.36),
             .005,pi-.005,-.488,.44,2*n)
    if central:
        shell_relief(m,x,-.59,4.30,.185,-1)
        shell_relief(m,x,.506,4.30,.185,1)
    lip(m, STONE[2], x,-.019,top-.055,top+.058,2*half+.02,.955,.014,.028)
    lip(m, STONE[4], x,-.019,top+.054,top+.125,2*half+.06,1.005,.014,.035)
    # Glazed rosettes sit in the spandrels outside the curve of the archivolt.
    for sign in (-1, 1):
        cx = x+sign*half*.82
        cz = top-(.38 if central else .29)
        for face in (-1, 1):
            y = -.445 if face < 0 else .408
            for rad, paint, distance in [(.165,STONE[4],.008),(.121,TILE,.022),(.060,HONEY,.033)]:
                outline = [(cx+rad*cos(tau*i/8),cz+rad*sin(tau*i/8)) for i in range(8)]
                yy = y+face*distance
                extrude(m,paint,outline, yy-.009,yy+.009)


def pergola(m, piers):
    for x in piers:
        lip(m, STONE[2], x,1.00,.65,.79,.46,.49,.026,.035)
        box(m, CEDAR[2], x,1.00,.79,4.74,.25,.26)
        for dx in (-.49, .49):
            beam(m,CEDAR[1],(x,1.00,4.16),(x+dx,1.00,4.71),.13,.14)
        if abs(x) > 5:
            molding(m, STONE[2], x,-.02,[(4.17,.62,.73),(4.23,.54,.61),
                                           (4.67,.54,.61),(4.75,.70,.72)],.035)
        for y in (-.08, 1.0):
            box(m,CEDAR[0],x,y,4.71,4.80,.63,.40)
    for y in (-.18, .96):
        box(m,CEDAR[1],0,y,4.775,4.98,17.42,.235)
        box(m,CEDAR[3],0,y-.005,4.91,4.958,17.49,.246)
    for j in range(31):
        x = (j-15)*.568
        # The ogee-cut tail is visible against the sky at both eaves.
        outline = [(-1.46,5.15),(1.42,5.15),(1.42,5.09),(1.34,5.09),
                   (1.28,5.055),(1.23,4.996),(1.12,4.963),(-1.13,4.963),
                   (-1.23,4.993),(-1.29,5.056),(-1.36,5.085),(-1.46,5.085)]
        extrude(m,m.rng.choice(CEDAR[1:4]),outline,x-.078,x+.078,"YZ")
    for y in (-1.03,-.49,.07,.64,1.17):
        box(m,CEDAR[3],0,y,5.143,5.205,17.35,.083)


def amphora(m, x, y, scale, planted):
    bottom = .65
    def profile(pairs):
        return [(bottom+z*scale,r*scale) for z,r in pairs]
    body = [(0,.17),(.045,.207),(.09,.193),(.15,.14),(.21,.16),(.30,.255),
            (.44,.348),(.58,.374),(.68,.348),(.755,.261),(.80,.169),(.90,.157),
            (.94,.194),(.977,.198),(.99,.174),(.98,.137),(.915,.128),(.858,.128)]
    lathe(m,POT,x,y,profile(body),20,caps=False)
    lathe(m,POT_DARK,x,y,profile([(.85,.13),(.86,.13)]),16)
    for h,r,w,paint in [(.045,.207,.027,POT_LIGHT),(.565,.376,.027,SLIP),
                         (.615,.371,.011,SLIP),(.89,.161,.026,POT_LIGHT)]:
        lathe(m,paint,x,y,profile([(h-w/2,r),(h+w/2,r)]),20,caps=False)
    for sign in (-1,1):
        handle = [(.16,.90),(.275,.94),(.372,.90),(.415,.80),(.408,.707),(.345,.62)]
        tube(m,POT_LIGHT,[(x+sign*a*scale,y,bottom+b*scale) for a,b in handle],
             [r*scale for r in (.042,.047,.048,.049,.050,.063)],7)
    if planted:
        root = Vector((x,y,bottom+.96*scale))
        for i in range(13):
            t = tau*i/13 + m.rng.uniform(-.16,.16)
            r = m.rng.uniform(.23,.44)*scale
            tip = root + Vector((r*cos(t),r*sin(t),m.rng.uniform(.10,.39)*scale))
            folded_leaf(m,m.rng.choice(PALM),root,tip,.065*scale,(0,0,.095*scale),
                        (-sin(t),cos(t),0))


def lantern(m, x):
    z, y = 1.77, -.89
    lip(m,BRONZE,x,-.534,2.19,2.47,.17,.08,.012,.02)
    tube(m,IRON,[(x,-.54,2.36),(x,-.65,2.42),(x,-.81,2.48),
                 (x,-.89,2.45),(x,y,2.40)],.023,8)
    for i in range(6):
        a = tau*i/6
        tube(m,IRON,[(x+.127*cos(a),y+.127*sin(a),z+.09),
                     (x+.174*cos(a),y+.174*sin(a),z+.445)],.014,5)
    lathe(m,AMBER,x,y,[(z+.095,.126),(z+.44,.173)],6,False)
    lathe(m,IRON,x,y,[(z,.035),(z+.052,.072),(z+.084,.143),(z+.108,.141)],6,False)
    lathe(m,BRONZE,x,y,[(z+.427,.181),(z+.462,.193),(z+.485,.187)],6,False)
    lathe(m,IRON,x,y,[(z+.48,.194),(z+.53,.15),(z+.584,.063),(z+.619,.035)],6,False)
    lathe(m,GOLD,x,y,[(z+.605,.035),(z+.638,.032)],8)


def garden_path(controls, spacing):
    """Sample a hand-drawn branch with a Catmull-Rom spline."""
    pts = [Vector(p) for p in controls]
    result = []
    for i in range(len(pts)-1):
        p, a, b, q = pts[max(0,i-1)],pts[i],pts[i+1],pts[min(i+2,len(pts)-1)]
        count = max(2, ceil((b-a).length/spacing))
        for j in range(count):
            t = j/count
            result.append(.5*((2*a)+(-p+b)*t+(2*p-5*a+4*b-q)*t*t+(-p+3*a-3*b+q)*t**3))
    return result+[pts[-1]]


def blossom(m, base, radius, coral):
    rng = m.rng
    phase = rng.uniform(0,tau)
    family = FLOWERS[4:6] if coral else FLOWERS[:4]
    for k in range(3):
        a = phase+tau*k/3+rng.uniform(-.18,.18)
        direction = Vector((cos(a),rng.uniform(-.52,-.1),sin(a)))
        tip = base+direction*radius
        tip.z = min(tip.z,5.39)
        folded_leaf(m,rng.choice(family),base,tip,radius*.42,(0,-radius*.23,.007))
    if rng.random() < .34:
        x,y,z = base
        s = radius*.16
        m.add(FLOWERS[6],[(x-s,y-.009,z-s*.4),(x+s,y-.012,z-s*.4),(x,y-.020,z+s)],[(0,1,2)])


def vine(m, controls, bloom, coral_mix, trailing=False):
    rng = m.rng
    path = garden_path(controls,.27 if trailing else .32)
    n = len(path)
    tube(m,VINE,path,[.030*(1-.70*i/(n-1)) for i in range(n)],5)
    for i, root in enumerate(path):
        t = i/(n-1)
        taper = 1-.52*t if trailing else 1
        sign = (-1)**i
        tip = root+Vector((sign*rng.uniform(.12,.31),rng.uniform(-.22,-.06),
                           rng.uniform(-.14,.14)))*taper
        tube(m,TWIG,[root,tip],.009*taper,4)
        for j in range(6):
            at = root.lerp(tip,.15+.14*j)
            angle = rng.uniform(0,tau)
            end = at+Vector((cos(angle)*rng.uniform(.15,.31),rng.uniform(-.12,.13),
                             sin(angle)*rng.uniform(.14,.27)))*taper
            end.z = min(5.40,end.z)
            folded_leaf(m,rng.choice(GREENERY),at,end,rng.uniform(.054,.094)*taper,
                        (0,-.025,.018))
        if rng.random() < bloom*(.77+.23*cos(4*pi*t)):
            coral = rng.random() < coral_mix
            for _ in range(rng.choice((3,4,4,5))):
                pos = tip+Vector((rng.uniform(-.12,.12),rng.uniform(-.075,.035),
                                  rng.uniform(-.10,.095)))*taper
                pos.z = min(pos.z,5.34)
                blossom(m,pos,rng.uniform(.075,.136)*taper,coral)


def bougainvillea(m):
    # The crowns grow over the timber and fork into unequal flowering falls.
    crowns = [
        ([(-8.28,.60,4.83),(-8.22,-.16,5.17),(-7.72,-1.10,5.20),
          (-6.61,-1.20,4.98),(-5.57,-1.03,5.17),(-4.61,-.87,5.10)],.95,.22),
        ([(-4.08,.23,5.06),(-3.78,-.67,5.19),(-2.94,-1.20,5.10),
          (-2.08,-1.07,5.22),(-1.23,-.74,5.08),(-.60,-.38,5.13)],.90,.16),
        ([(.53,.62,5.13),(1.30,.04,5.18),(2.05,-.80,5.21),
          (2.93,-1.16,5.02),(3.78,-1.06,5.12),(4.38,-.76,5.22)],.94,.55),
        ([(5.27,-.06,5.10),(5.78,-.82,5.19),(6.55,-1.04,5.06),
          (7.54,-1.18,5.18),(8.10,-.69,5.10),(8.20,.31,5.19)],.94,.32),
        ([(-8.17,.76,4.77),(-7.54,1.13,5.12),(-6.84,1.00,5.17),
          (-5.96,.96,5.04)],.68,.28),
        ([(2.63,.16,5.12),(3.13,.81,5.16),(4.04,1.05,5.11),
          (4.91,.91,5.15),(5.59,.59,5.06)],.65,.45),
    ]
    for controls,bloom,coral in crowns:
        vine(m,controls,bloom,coral)
    falls = [(-7.78,1.65,.16),(-7.12,.82,.32),(-5.74,.64,.26),
             (-3.18,1.55,.16),(-2.72,.87,.12),(-1.83,.64,.18),
             (2.78,1.39,.64),(3.42,.89,.50),(5.83,.75,.25),
             (7.40,1.12,.32),(7.90,1.74,.20)]
    for i,(x,length,coral) in enumerate(falls):
        s = (-1)**i
        vine(m,[(x,-1.03,5.16),(x+.14*s,-1.28,4.98),
                (x-.12*s,-1.19,5.06-length*.50),
                (x+.16*s,-.96,5.08-length*.78),(x+.08*s,-.90,5.08-length)],
             .94,coral,True)


def coral_cove():
    m = Model(727)
    piers = [-7.80,-2.91,2.91,7.80]
    terrace(m)
    for x in piers:
        limestone_column(m,x)
    for i in range(3):
        stone_arch(m,piers[i],piers[i+1],i == 1)
    pergola(m,piers)
    for s in (-1,1):
        amphora(m,s*8.23,-.90,1.01,True)
        amphora(m,s*2.52,-.99,.87,False)
        lantern(m,s*2.91)
    bougainvillea(m)
    return m


class Elevation:
    """Orient local joinery on a wall. Negative local Y points out of the wall."""
    def __init__(self, model, x, y, angle=0):
        self.model, self.x, self.y = model, x, y
        self.c, self.s = cos(angle), sin(angle)
        self.rng = model.rng

    def add(self, paint, vertices, faces, smooth=False):
        self.model.add(paint,[(self.x+self.c*x-self.s*y,self.y+self.s*x+self.c*y,z)
                              for x,y,z in vertices],faces,smooth)


def veranda(m):
    lip(m,STONE[1],0,.19,0,.15,17.34,3.69,.029,.08)
    box(m,STONE[2],0,.19,.14,.405,17.16,3.50)
    box(m,SHADOW,0,.17,.375,.466,17.29,3.56)
    lip(m,WHITE,0,.15,.443,.524,17.43,3.66,.014,.025)
    for i in range(66):
        w = 17.32/66
        x = -8.66+(i+.5)*w
        box(m,m.rng.choice(CEDAR[2:]),x,.16,.514,.55,w-.006,3.57)
    for i,(nose,w,z0,z1) in enumerate([(-2.20,4.26,0,.139),
                                          (-2.015,4.15,.139,.277),(-1.83,4.04,.277,.415)]):
        rear = -1.52
        box(m,STONE[2],0,(nose+rear)/2+.022,z0,z1-.03,w-.055,rear-nose-.044)
        lip(m,STONE[4] if i < 2 else IVORY,0,(nose+rear)/2,z1-.039,z1,w,rear-nose,.009)


def clapboards(m, width):
    for i in range(15):
        z = .58+i*.183
        a, b = -width/2, width/2
        m.add(SIDING,[(a,-.044,z),(b,-.044,z),(b,-.008,z+.18),(a,-.008,z+.18)],
              [(0,1,2,3)])
        m.add(SIDING_SHADE,[(a,-.009,z),(b,-.009,z),(b,-.044,z),(a,-.044,z)],
              [(0,1,2,3)])


def louver(m, x, y, z, w, h, paint):
    # Bent timber blades have a projecting lower lip and a visible dark throat.
    a, b = x-w/2, x+w/2
    verts = [(a,y-.045,z),(b,y-.045,z),(b,y-.045,z+.018),(a,y-.045,z+.018),
             (b,y,z+h),(a,y,z+h)]
    m.add(paint,verts,[(0,1,2,3),(3,2,4,5)])


def shutter(m, center, width, bottom, top):
    box(m,FOREST,center,-.081,bottom,top,width,.075)
    for x in (center-width/2+.023,center+width/2-.023):
        box(m,JADE,x,-.134,bottom,top,.045,.042)
    for z in (bottom+.035,(top+bottom)/2,top-.035):
        box(m,JADE,center,-.142,z-.032,z+.032,width-.044,.048)
    n = max(5,round((top-bottom-.13)/.103))
    for i in range(n):
        z = bottom+.061+i*(top-bottom-.13)/n
        louver(m,center,-.112,z,width-.085,.068,JADE)


def window_set(m, center, w, bottom, top, door=False, lit=False, shutters=True):
    # Warm panes sit inside a dark glazing rebate. The upper lights pick up sky.
    box(m,FOREST,center,-.071,bottom,top,w,.082)
    sill = bottom+(.24 if door else .10)
    transom = top-.33
    box(m,LIT if lit else GLASS,center,-.121,sill,top-.077,w-.13,.023)
    box(m,SEA_GLASS,center,-.14,transom,top-.080,w-.14,.013)
    for edge in (-1,1):
        x = center+edge*w/2
        box(m,IVORY,x,-.123,bottom-.032,top+.042,.105,.138)
        if shutters:
            sw = .425 if door else .325
            shutter(m,x+edge*(sw/2+.075),sw,bottom+.025,top-.025)
    box(m,WHITE,center,-.13,top-.027,top+.065,w+.19,.16)
    lip(m,IVORY,center,-.13,top+.055,top+.12,w+.31,.21,.013)
    box(m,WHITE,center,-.155,bottom-.034,bottom+.045,w+.22,.193)
    for x in (center-w*.25,center,center+w*.25):
        box(m,IVORY,x,-.154,sill,top-.063,.045 if x == center else .025,.037)
    levels = [sill,sill+(transom-sill)*.48,transom]
    if door:
        levels.insert(2,sill+(transom-sill)*.75)
        for s in (-1,1):
            box(m,JADE,center+s*w*.245,-.128,bottom+.036,sill-.023,w*.41,.038)
            box(m,GOLD,center+s*.075,-.196,bottom+.78,bottom+.93,.030,.033)
    for z in levels:
        box(m,IVORY,center,-.159,z-.020,z+.020,w-.084,.04)


def club_walls(m):
    box(m,SIDING,0,.90,.55,3.39,16.24,1.98)
    front = Elevation(m,0,-.09)
    back = Elevation(m,0,1.89,pi)
    for wall in (front,back):
        clapboards(wall,16.24)
    for s in (-1,1):
        end = Elevation(m,s*8.12,.90,s*pi/2)
        clapboards(end,1.98)
        window_set(end,0,.84,1.05,2.64,shutters=False)
        window_set(front,s*3.64,1.43,.575,2.76,True,True)
        window_set(front,s*6.66,1.23,.91,2.66,lit=True)
        for x in (2.64,6.02):
            window_set(back,s*x,1.24,1.01,2.69,lit=False)
        for y in (-.09,1.89):
            box(m,IVORY,s*8.105,y,.55,3.32,.146,.137)
    window_set(front,0,1.85,.575,2.80,True,True)
    window_set(back,0,1.52,.575,2.77,door=True,lit=True,shutters=False)


def porch_column(m, x, height):
    y = -1.45
    lip(m,IVORY,x,y,.55,.675,.47,.465,.023,.025)
    molding(m,WHITE,x,y,[(.675,.392,.394),(1.15,.365,.367),(1.21,.423,.423),
                          (1.255,.423,.423),(1.29,.36,.36)],.024)
    lathe(m,IVORY,x,y,[(1.275,.171),(1.31,.193),(1.37,.18),(1.40,.147)],12)
    lathe(m,WHITE,x,y,[(1.394,.149),(1.59,.152),(height-.22,.120)],12)
    lathe(m,IVORY,x,y,[(height-.235,.123),(height-.20,.148),(height-.166,.148),
                        (height-.109,.193),(height-.077,.193)],12)
    lip(m,WHITE,x,y,height-.089,height,.434,.434,.012,.018)


def railing(m, a, b, count):
    a,b = Vector((*a,0)), Vector((*b,0))
    for z,w,h,paint in [(.714,.13,.097,IVORY),(1.249,.126,.071,IVORY),
                        (1.308,.184,.068,WHITE)]:
        beam(m,paint,a+Vector((0,0,z)),b+Vector((0,0,z)),w,h)
    for i in range(count):
        p = a.lerp(b,(i+.5)/count)
        lathe(m,WHITE,p.x,p.y,[(.75,.065),(.79,.068),(.818,.044),(.937,.082),
                                (1.002,.078),(1.089,.040),(1.155,.040),
                                (1.189,.060),(1.230,.062)],6,caps=False)


def awning(m, sign):
    a, b = (2.06,8.36) if sign > 0 else (-8.36,-2.06)
    # Bias-cut canvas sags gently between the wall and the oak front roller.
    section = [(-1.895,2.82),(-1.66,2.866),(-1.27,2.923),
               (-.88,3.013),(-.50,3.126),(-.235,3.23)]
    count = 19
    for i in range(count):
        left,right = a+(b-a)*i/count,a+(b-a)*(i+1)/count
        green = (i%2 == 0)
        paint = CLOTH[0 if green else 2]
        verts = [(x,y,z) for y,z in section for x in (left,right)]
        m.add(paint,verts,[(j*2,j*2+1,j*2+3,j*2+2) for j in range(len(section)-1)])
        cx, r = (left+right)/2,(right-left)/2
        points = [(left,2.829),(left,2.716)]
        points += [(cx-r*cos(pi*j/8),2.716-.102*sin(pi*j/8)) for j in range(1,9)]
        points += [(right,2.829)]
        extrude(m,CLOTH[1 if green else 3],points,-1.912,-1.886)
        # A narrow sewn hem follows the scallop itself.
        edge = [(cx-r*cos(pi*j/8),-1.918,2.718-.102*sin(pi*j/8)) for j in range(9)]
        m.add(IVORY,edge+[(x,y,z+.014) for x,y,z in edge],
              [(j,j+1,j+10,j+9) for j in range(8)])
    box(m,FOREST,(a+b)/2,-1.82,2.777,2.825,b-a,.072)
    box(m,IVORY,(a+b)/2,-1.45,2.855,2.94,b-a,.16)
    for x in (a+.08,b-.08):
        beam(m,BRONZE,(x,-.22,3.18),(x,-1.875,2.795),.038,.04)


def clock_face(m):
    z = 3.79
    def disc(paint, profile, sides=48):
        rings = [[(r*cos(tau*i/sides),y,z+r*sin(tau*i/sides)) for i in range(sides)]
                 for y,r in profile]
        loft(m,paint,rings,True)
    disc(FOREST,[(-1.88,.53),(-1.94,.541),(-1.975,.515)])
    disc(BRONZE,[(-1.967,.515),(-1.992,.513),(-2.007,.481)])
    disc(GOLD,[(-1.985,.508),(-2.010,.505),(-2.022,.476)])
    disc(IVORY,[(-2.015,.472),(-2.025,.460)])
    def hand(paint, angle, outline, y, thick):
        s,c = sin(angle),cos(angle)
        pts = [(u*c+v*s,z-u*s+v*c) for u,v in outline]
        extrude(m,paint,pts,y-thick,y)
    for i in range(60):
        major = i%5 == 0
        length,width = (.093,.022) if major else (.028,.007)
        t = i*tau/60
        top = .437
        s,c = sin(t),cos(t)
        face = [(u*c+v*s,-2.03,z-u*s+v*c)
                for u,v in [(-width/2,top-length),(width/2,top-length),(width/2,top),(-width/2,top)]]
        m.add(FOREST if major else BRONZE,face,[(0,1,2,3)])
    hand(FOREST,-tau*1.84/12,[(-.023,-.067),(.023,-.067),(.032,.203),(0,.284),(-.032,.203)],-2.033,.012)
    hand(FOREST,tau*10/60,[(-.016,-.081),(.016,-.081),(.021,.273),(0,.373),(-.021,.273)],-2.047,.011)
    hand(COPPER,pi*.91,[(-.006,-.082),(.006,-.082),(.006,.326),(0,.355),(-.006,.326)],-2.06,.005)
    disc(GOLD,[(-2.064,.036),(-2.078,.039),(-2.086,.026)],16)


def clock_portico(m):
    spring, rx, rz = 3.36, 2.05, 1.103
    profile = [(-rx,3.055),(rx,3.055)]
    profile += [(rx*cos(pi*i/32),spring+rz*sin(pi*i/32)) for i in range(33)]
    extrude(m,SIDING,profile,-1.84,.19)
    # Horizontal board reveals terminate precisely at the curved rake.
    for j in range(6):
        z = 3.40+j*.164
        extent = rx*sqrt(1-((z-spring)/rz)**2)-.06
        box(m,IVORY,0,-1.847,z,z+.013,2*extent,.018)
    arc_band(m,FOREST,0,spring,(2.02,1.08),(2.15,1.205),0,pi,-1.923,.24,40)
    arc_band(m,WHITE,0,spring,(1.925,.994),(2.033,1.097),0,pi,-1.903,-1.82,40)
    arc_band(m,IVORY,0,spring,(2.09,1.149),(2.158,1.218),0,pi,-1.959,-1.86,40)
    for z0,z1,w,d,paint in [(3.048,3.118,4.31,.26,IVORY),(3.118,3.245,4.18,.21,WHITE),
                              (3.24,3.275,4.28,.24,GOLD),(3.275,3.355,4.34,.29,IVORY)]:
        box(m,paint,0,-1.77,z0,z1,w,d)
    for s in (-1,1):
        box(m,IVORY,s*2.04,-.98,3.07,3.22,.19,1.62)
        beam(m,IVORY,(s*2.08,-1.45,2.79),(s*1.73,-1.75,3.095),.12,.125)
    clock_face(m)


def pavilion_roof(m):
    # Classical entablature, dentil cornice, and a hipped cedar-shingle roof over the clubhouse.
    lip(m,IVORY,0,.52,3.25,3.37,17.08,3.68,.018,.04)
    box(m,WHITE,0,.52,3.36,3.50,17.34,3.88)
    lip(m,IVORY,0,.50,3.49,3.62,17.64,4.16,.026,.05)
    # Dentil trim beneath the front and rear eaves.
    for face in (-1,1):
        y = .50 + face*1.90
        for i in range(-28,29):
            if face < 0 and abs(i*.29) < 2.20:
                continue
            box(m,MILK,i*.29,y,3.37,3.48,.11,.13)
    # Tiered hipped cedar-shake courses with crisp stepped laps and subtle tonal variation.
    courses = 16
    z_base, z_top = 3.60, 5.42
    w_base, w_top = 17.78, 12.10
    d_base, d_top = 4.30, .42
    cy = .55
    shake_cycle = [SHAKES[1], SHAKES[2], SHAKES[5], SHAKES[3], SHAKES[2], SHAKES[1]]
    for c in range(courses):
        t0, t1 = c/courses, (c+1)/courses
        z0 = z_base + (z_top-z_base)*t0
        z1 = z_base + (z_top-z_base)*t1 + .026
        w0 = w_base + (w_top-w_base)*t0 + .028
        w1 = w_base + (w_top-w_base)*t1
        d0 = d_base + (d_top-d_base)*t0 + .028
        d1 = d_base + (d_top-d_base)*t1
        paint = shake_cycle[c % len(shake_cycle)]
        molding(m,paint,0,cy,[(z0,w0,d0),(z1,w1,d1)],.03)
    # Standing-seam copper ridge beam & hip ribs.
    lip(m,PATINA,0,cy,z_top-.02,z_top+.11,w_top+.14,.32,.024,.03)
    for sx in (-1,1):
        for sy in (-1,1):
            beam(m,PATINA,(sx*w_base/2,cy+sy*d_base/2,z_base+.04),
                 (sx*w_top/2,cy+sy*d_top/2,z_top+.04),.10,.09)


def cupola(m):
    cy = .55
    # Square shingle-skirted pedestal rooted deep into the hipped roof so there is zero gap.
    molding(m,SHAKES[1],0,cy,[(4.65,2.52,2.52),(5.56,1.98,1.98)],.06)
    lip(m,IVORY,0,cy,5.55,5.69,2.14,2.14,.025,.05)
    lip(m,WHITE,0,cy,5.68,5.84,1.86,1.86,.02,.08)
    # Octagonal louvered lantern drum with glowing warm interior core.
    lathe(m,AMBER,0,cy,[(5.86,.66),(6.68,.66)],8,False,pi/8)
    for i in range(8):
        a = pi/8 + tau*i/8
        px, py = .84*cos(a), cy + .84*sin(a)
        box(m,WHITE,px,py,5.82,6.74,.14,.14)
        # Slatted timber louvers across each face between corner pilasters.
        b = tau*i/8
        fx, fy = .76*cos(b), cy + .76*sin(b)
        e = Elevation(m,fx,fy,b+pi/2)
        for k in range(5):
            louver(e,0,0,5.94+k*.145,.52,.075,JADE)
    # Octagonal entablature & flared weathered-copper ogee cupola roof.
    lathe(m,IVORY,0,cy,[(6.70,.96),(6.80,1.03),(6.87,1.03)],8,False,pi/8)
    dome = [(6.86,1.06),(6.96,.95),(7.12,.79),(7.30,.56),(7.46,.31),(7.58,.11),(7.62,.04)]
    lathe(m,PATINA,0,cy,dome,8,False,pi/8)
    for i in range(8):
        a = pi/8 + tau*i/8
        pts = [(r*cos(a),cy+r*sin(a),z+.015) for z,r in dome]
        tube(m,COPPER,pts,.024,5)
    # Turned gold ball & weathervane finial.
    lathe(m,GOLD,0,cy,[(7.60,.08),(7.68,.135),(7.77,.135),(7.84,.065),
                       (7.92,.042),(8.12,.022),(8.26,.008)],14)


def pavilion_lantern(m, x):
    y, z = -.24, 2.24
    lip(m,BRONZE,x,-.12,z+.02,z+.26,.14,.07,.01,.02)
    tube(m,IRON,[(x,-.12,z+.14),(x,-.24,z+.14),(x,y,z+.08)],.018,6)
    lathe(m,AMBER,x,y,[(z-.16,.085),(z+.06,.115)],6,False)
    lathe(m,IRON,x,y,[(z-.22,.025),(z-.15,.095)],6,False)
    lathe(m,IRON,x,y,[(z+.05,.125),(z+.14,.045)],6,False)
    lathe(m,GOLD,x,y,[(z+.13,.032),(z+.18,.012)],8)


def boxwood_planter(m, x, y, scale=1.0):
    s = scale
    lip(m,IVORY,x,y,0,.09*s,.84*s,.84*s,.016*s,.02*s)
    molding(m,WHITE,x,y,[(.08*s,.76*s,.76*s),(.64*s,.82*s,.82*s)],.02*s)
    # Inset architectural panel frames on all four sides.
    box(m,IVORY,x,y,.18*s,.54*s,.84*s,.56*s)
    box(m,IVORY,x,y,.18*s,.54*s,.56*s,.84*s)
    lip(m,WHITE,x,y,.63*s,.74*s,.92*s,.92*s,.02*s,.025*s)
    box(m,VINE,x,y,.68*s,.73*s,.74*s,.74*s)
    # Lush clustered manicured boxwood topiary built from overlapping sculpted lobes.
    def bush_lobe(lx, ly, lz, rad, paint):
        rings = []
        for k in range(1,6):
            ang = pi*(k/6 - .5)
            rr = rad*cos(ang)
            rings.append([(lx+rr*(1+.08*cos(5*tau*i/10))*cos(tau*i/10),
                           ly+rr*(1+.08*sin(3*tau*i/10))*sin(tau*i/10),
                           lz+rad*.92*sin(ang)) for i in range(10)])
        loft(m,paint,rings,True)
    cx, cy, cz = x, y, 1.06*s
    bush_lobe(cx, cy, cz, .36*s, BOXWOOD[0])
    for i in range(7):
        a = tau*i/7 + .3
        rad = .24*s if i%2 else .21*s
        bush_lobe(cx+.22*s*cos(a), cy+.22*s*sin(a), cz+(.05 if i%2 else -.06)*s, rad, BOXWOOD[1 + (i%4)])
    bush_lobe(cx, cy, cz+.22*s, .24*s, BOXWOOD[4])
    for _ in range(36):
        theta = m.rng.uniform(0,tau)
        phi = m.rng.uniform(-.25,1.20)
        rad = .40*s*m.rng.uniform(.86,1.04)
        root = Vector((cx+rad*cos(phi)*cos(theta),cy+rad*cos(phi)*sin(theta),cz+rad*sin(phi)))
        tangent = Vector((-sin(theta),cos(theta),.35)).normalized()
        tip = root + tangent*m.rng.uniform(.10,.16)*s
        folded_leaf(m,m.rng.choice(BOXWOOD[1:]),root,tip,.062*s,(0,0,.025*s))


def emerald_pavilion():
    m = Model(941)
    veranda(m)
    club_walls(m)
    for s in (-1,1):
        porch_column(m,s*2.04,3.07)
        porch_column(m,s*4.96,2.86)
        porch_column(m,s*8.10,2.86)
        railing(m,(s*2.24,-1.45),(s*4.76,-1.45),11)
        railing(m,(s*5.16,-1.45),(s*7.90,-1.45),12)
        railing(m,(s*8.10,-1.25),(s*8.10,-.16),5)
        awning(m,s)
        pavilion_lantern(m,s*1.36)
        boxwood_planter(m,s*2.55,-2.05,.96)
        boxwood_planter(m,s*8.52,-1.65,.88)
    clock_portico(m)
    pavilion_roof(m)
    cupola(m)
    return m


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


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
        export_vertex_color="MATERIAL",
    )
    data = path.read_bytes()
    chunk_len = struct.unpack_from("<I", data, 12)[0]
    meta = json.loads(data[20:20 + chunk_len].decode("utf-8"))
    mats = [mt.get("name") for mt in meta.get("materials", [])]
    has_color = any("COLOR_0" in p.get("attributes", {}) for ms in meta.get("meshes", []) for p in ms.get("primitives", []))
    print(f"[GLB] {path.name}: {len(data)/1024:.1f} KB | mats={len(mats)} | COLOR_0={has_color}")
    assert has_color, f"Missing COLOR_0 vertex colors in {path.name}"
    assert LAMP in mats, f"Missing {LAMP} in {path.name}"


def render_venue_preview(out_path, cam_loc, target):
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 6
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("VenueSky")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.48, 0.72, 0.88, 1.0)
    bg.inputs["Strength"].default_value = 0.85

    sun_data = bpy.data.lights.new("Sun", type="SUN")
    sun_data.energy = 3.8
    sun_data.color = (1.0, 0.94, 0.82)
    sun = bpy.data.objects.new("Sun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (0.72, 0.16, 0.54)

    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, 0))
    ground = bpy.context.active_object
    gmat = bpy.data.materials.new("Ground")
    gmat.use_nodes = True
    gmat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = linear_rgba("d8cfb9")
    gmat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.88
    ground.data.materials.append(gmat)

    cd = bpy.data.cameras.new("Cam")
    cd.lens = 36
    co = bpy.data.objects.new("Cam", cd)
    scene.collection.objects.link(co)
    co.location = Vector(cam_loc)
    co.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = co

    scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)


def main():
    # 1. Coral Cove Limestone Archway & Pergola
    clear_scene()
    objs = coral_cove().objects(glow=1.4)
    export_glb(objs, MODELS / "coral_cove_arch.glb")
    render_venue_preview(PREVIEWS / "coral_cove_preview.png", (-8.5, -17.5, 4.4), (0.0, 0.0, 2.7))

    # 2. Emerald Terrace Coastal Club Pavilion
    clear_scene()
    objs = emerald_pavilion().objects(glow=1.2)
    export_glb(objs, MODELS / "emerald_pavilion.glb")
    render_venue_preview(PREVIEWS / "emerald_pavilion_preview.png", (9.0, -18.5, 5.2), (0.0, 0.2, 3.3))

    print("[OK] Both venue hero GLBs exported and rendered cleanly.")


if __name__ == "__main__":
    main()
