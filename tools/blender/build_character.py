"""Build Lagoon Open's rigid, tintable tennis athlete and head-local wardrobe.

Run with Blender's --background --python. All dimensions below are metres.
The source of truth is the neutral pose. Studio posing happens after export.
"""

import json
import math
import os
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public/models/characters"
PREVIEWS = ROOT / "tools/blender/previews/characters"
TMP = ROOT / ".blender_tmp"
TAU = math.tau
sin, cos, pi, exp = math.sin, math.cos, math.pi, math.exp
V = Vector

PALETTE = {
    "Skin": ("eeb18a", .50), "Shirt": ("e64e52", .78),
    "Stripe": ("fff0ce", .78), "Shorts": ("223650", .82),
    "Shoe": ("f9faf4", .48), "Sole": ("bb784e", .68),
    "Sock": ("f2eee2", .90), "Band": ("f9e1b6", .88),
    "Hair": ("392723", .58), "Accent": ("efad46", .45),
    "EyeWhite": ("fff9ec", .18), "Pupil": ("211e24", .10),
    "Mouth": ("924b40", .45),
}
MATERIALS = {}
PIVOTS = {
    "CharacterRoot": (None, (0, 0, 0)),
    "Pelvis": ("CharacterRoot", (0, 0, .88)),
    "Chest": ("Pelvis", (0, 0, .13)),
    "Head": ("Chest", (0, 0, .43)),
    "HeadbandTail_L": ("Head", (-.055, .12, .04)),
    "HeadbandTail_R": ("Head", (.055, .12, .04)),
    "BackNumberAnchor": ("Chest", (0, .138, .28)),
}
for side, sign in (("L", 1), ("R", -1)):
    PIVOTS.update({
        "UpperArm_" + side: ("Chest", (sign * .195, 0, .34)),
        "Forearm_" + side: ("UpperArm_" + side, (0, 0, -.26)),
        "Hand_" + side: ("Forearm_" + side, (0, 0, -.25)),
        "RacketSocket_" + side: ("Forearm_" + side, (0, -.02, -.26)),
        "Thigh_" + side: ("Pelvis", (sign * .10, 0, -.05)),
        "Shin_" + side: ("Thigh_" + side, (0, 0, -.41)),
    })
WARDROBE = ("Hair_Classic", "Hair_Ponytail", "Hair_Mohawk", "Hair_Curly",
            "Hair_Bob", "Hat_Visor", "Hat_Cap", "Hat_Captain")


def linear_color(hex_color):
    def linear(v):
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    return tuple(linear(int(hex_color[i:i+2], 16) / 255) for i in (0, 2, 4)) + (1.,)


def material(name, color, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    mat.diffuse_color = linear_color(color)
    bsdf.inputs["Base Color"].default_value = mat.diffuse_color
    bsdf.inputs["Roughness"].default_value = roughness
    mat.roughness = roughness
    mat.use_backface_culling = True
    return mat


def empty(name, parent=None, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = .035
    obj.parent = parent
    obj.location = location
    return obj


def mix(a, b, t):
    return a + (b - a) * t


def clamp(t, lo=0., hi=1.):
    return min(max(t, lo), hi)


def power(x, p):
    return math.copysign(abs(x) ** p, x)


def at_profile(rows, z):
    """Interpolate all cross-section dimensions at a given height."""
    if z <= rows[0][0]:
        return rows[0][1:]
    for a, b in zip(rows, rows[1:]):
        if z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return tuple(mix(x, y, t) for x, y in zip(a[1:], b[1:]))
    return rows[-1][1:]


def ring(n, point):
    return [point(TAU * i / n) for i in range(n)]


def ellipse(t, z, rx, ry, cx=0., cy=0., p=1.):
    return V((cx + rx * power(sin(t), p), cy - ry * power(cos(t), p), z))


class Part:
    """Several closed, smooth sculpted pieces baked into one rigid mesh."""

    def __init__(self):
        self.vertices, self.faces, self.shader, self.smooth = [], [], [], []

    def loft(self, rows, bands, *, loop=False, ends=None, smooth_ends=False):
        rows = [[V(p) for p in r] for r in rows]
        n, m = len(rows[0]), len(rows)
        strips = m if loop else m - 1
        if isinstance(bands, str):
            bands = [bands] * strips
        assert len(bands) == strips and all(len(r) == n for r in rows)
        verts = [p for row in rows for p in row]
        faces, colors, smooth = [], [], []
        for j, mat in enumerate(bands):
            k = (j + 1) % m
            for i in range(n):
                h = (i + 1) % n
                faces.append((j*n+i, j*n+h, k*n+h, k*n+i))
                colors.append(mat)
                smooth.append(True)
        if not loop:
            if ends is None:
                ends = (sum(rows[0], V((0, 0, 0))) / n,
                        sum(rows[-1], V((0, 0, 0))) / n)
            for j, center, mat in ((0, ends[0], bands[0]), (m-1, ends[1], bands[-1])):
                pole = len(verts)
                verts.append(V(center))
                for i in range(n):
                    h = (i + 1) % n
                    faces.append((pole, j*n+h, j*n+i) if j == 0 else (pole, j*n+i, j*n+h))
                    colors.append(mat)
                    smooth.append(smooth_ends)
        # A mirrored shoe, a sideways ear and a swept ribbon can all use the
        # same loft. Orient each independent watertight island before joining.
        origin = verts[0]
        rel = [p - origin for p in verts]
        volume6 = sum(rel[f[0]].dot(rel[f[k]].cross(rel[f[k+1]]))
                      for f in faces for k in range(1, len(f)-1))
        if abs(volume6) < 1e-14:
            raise ValueError("Collapsed sculpt section")
        if volume6 < 0:
            faces = [f[::-1] for f in faces]
        start = len(self.vertices)
        self.vertices.extend(verts)
        self.faces.extend(tuple(start + i for i in f) for f in faces)
        self.shader.extend(colors)
        self.smooth.extend(smooth)

    def sections(self, rows, bands, n=18, p=1.):
        # row = (height, x radius, y radius[, x offset, y offset])
        self.loft([ring(n, lambda t: ellipse(t, *row, p=p)) for row in rows], bands)

    def oval(self, center, radii, mat, n=14, lat=7, axes=None):
        c = V(center)
        a, b, d = (V(i) for i in (axes or ((1, 0, 0), (0, 1, 0), (0, 0, 1))))
        a, b, d = a * radii[0], b * radii[1], d * radii[2]
        rows = []
        for k in range(1, lat):
            ang = pi * (k / lat - .5)
            rows.append(ring(n, lambda t: c + d*sin(ang) + (a*cos(t) + b*sin(t))*cos(ang)))
        self.loft(rows, mat, ends=(c-d, c+d), smooth_ends=True)

    def sweep(self, pts, widths, depths, mat, *, sides=8, guide=(1, 0, 0),
              normals=None, steps=1):
        """Loft a varying elliptic section along a Catmull-Rom centreline."""
        pts = [V(p) for p in pts]
        samples, ws, ds, ns = [], [], [], []
        for i in range(len(pts)-1):
            a, b, c, d = pts[max(0, i-1)], pts[i], pts[i+1], pts[min(i+2, len(pts)-1)]
            for k in range(steps):
                t = k / steps
                pos = .5 * (2*b + (-a+c)*t + (2*a-5*b+4*c-d)*t*t + (-a+3*b-3*c+d)*t*t*t)
                samples.append(pos)
                ws.append(mix(widths[i], widths[i+1], t))
                ds.append(mix(depths[i], depths[i+1], t))
                if normals is not None:
                    ns.append(V(normals[i]).lerp(V(normals[i+1]), t).normalized())
        samples.append(pts[-1])
        ws.append(widths[-1])
        ds.append(depths[-1])
        if normals is not None:
            ns.append(V(normals[-1]))
        rows = []
        for i, p in enumerate(samples):
            tangent = (samples[min(i+1, len(samples)-1)] - samples[max(0, i-1)]).normalized()
            if ns:
                u = ns[i].cross(tangent).normalized()
            else:
                ref = V(guide)
                u = ref - tangent*ref.dot(tangent)
                if u.length < .08:
                    u = tangent.orthogonal()
                u.normalize()
            v = tangent.cross(u).normalized()
            rows.append(ring(sides, lambda t: p + u*(ws[i]*cos(t)) + v*(ds[i]*sin(t))))
        self.loft(rows, mat)

    def relief(self, outline, mat, lift=.001, normal=(0, -1, 0)):
        """A softly bevelled appliqué, with its back tucked into the cloth."""
        outline = [V(p) for p in outline]
        c = sum(outline, V((0, 0, 0))) / len(outline)
        n = V(normal).normalized()
        self.loft([[p-n*.001 for p in outline], outline,
                   [c+(p-c)*.84+n*lift for p in outline]], mat)

    def object(self, name, parent=None):
        mesh = bpy.data.meshes.new(name + "_Geometry")
        mesh.from_pydata(self.vertices, [], self.faces)
        if mesh.validate(verbose=False):
            raise ValueError("Invalid faces in " + name)
        mesh.update()
        slots = {}
        for key in dict.fromkeys(self.shader):
            slots[key] = len(slots)
            mesh.materials.append(MATERIALS[key])
        mesh.polygons.foreach_set("material_index", [slots[k] for k in self.shader])
        mesh.polygons.foreach_set("use_smooth", self.smooth)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.parent = parent
        return obj


# The head surface also drives eyelids, the terry wrap and every hairline.
HEAD = [
    (-.023, .018, .019, -.038), (-.018, .051, .053, -.034),
    (-.002, .082, .079, -.026), (.023, .112, .102, -.016),
    (.050, .136, .118, -.008), (.078, .151, .131, -.003),
    (.103, .159, .139, .001), (.127, .161, .143, .002),
    (.150, .160, .144, .003), (.174, .157, .143, .004),
    (.198, .151, .139, .006), (.222, .139, .130, .008),
    (.245, .118, .114, .011), (.264, .087, .086, .013),
    (.276, .049, .049, .014), (.280, .009, .009, .014),
]


def face_shift(x, z):
    ax = abs(x)
    orbit = .012 * exp(-((ax-.063)/.038)**2 - ((z-.123)/.025)**2)
    cheek = .008 * exp(-((ax-.089)/.040)**2 - ((z-.079)/.028)**2)
    muzzle = .005 * exp(-(x/.062)**2 - ((z-.047)/.035)**2)
    return orbit - cheek - muzzle


def head_at(t, z):
    rx, ry, cy = at_profile(HEAD, z)
    p = ellipse(t, z, rx, ry, 0, cy, .90)
    p.y += face_shift(p.x, z) * max(0., cos(t))**2
    return p


def face_y(x, z):
    rx, ry, cy = at_profile(HEAD, z)
    c = math.sqrt(max(0., 1 - min(1., abs(x)/rx)**(2/.90)))
    return cy - ry*c**.90 + face_shift(x, z)*c*c


def make_portrait():
    head = Part()
    head.loft([ring(36, lambda t: head_at(t, z)) for z, *_ in HEAD], "Skin")
    for s in (-1, 1):
        # The ear is a shell with an actual helix and concha. Its face is
        # visible from both the sideline and the three-quarter portrait.
        normal = V((s*.81, -.58, 0))
        across = V((s*.58, .81, 0))
        up = V((0, .12, .993))
        origin = V((s*.151, .001, .101))
        rows = []
        for width, height, out, dz in ((.018, .032, -.008, 0), (.026, .039, .003, 0),
                                      (.026, .039, .011, .001), (.018, .029, .019, .002),
                                      (.012, .021, .014, .001), (.007, .012, .008, -.001)):
            rows.append(ring(16, lambda t: origin + normal*out + across*(width*cos(t)*(1+.15*sin(t)))
                             + up*(height*sin(t)+dz)))
        head.loft(rows, "Skin")
        head.oval(origin+normal*.013-across*.010-up*.005, (.007, .006, .010),
                  "Skin", 8, 4, axes=(across, normal, up))
    # A single sculpted bridge and tip, tapering into the brow and cheeks.
    head.sections([(.069, .009, .006, 0, -.144), (.073, .021, .014, 0, -.148),
                   (.082, .024, .019, 0, -.151), (.092, .020, .021, 0, -.151),
                   (.103, .014, .016, 0, -.146), (.123, .011, .010, 0, -.139),
                   (.140, .008, .005, 0, -.137)], "Skin", 16)
    return head


def make_expression():
    face = Part()
    for s in (-1, 1):
        cx, cz = s*.062, .123 + (.001 if s == 1 else 0)
        rows = []
        # Continuous eyewhite, limbal ring, warm iris and glossy pupil.
        # Sparse geometry at the inner canthus gives the eye an almond shape.
        for w, h, offset, gaze, almond in (
            (.041, .025, -.004, 0, 1), (.041, .025, .002, 0, 1),
            (.035, .024, .0065, 0, .7), (.019, .021, .011, -.003, 0),
            (.0165, .019, .012, -.003, 0), (.0108, .0134, .014, -.003, 0),
            (.004, .005, .015, -.003, 0),
        ):
            def eye(t):
                x = cx + gaze + w*cos(t)
                z = cz + h*sin(t)*(1-almond*.32*abs(cos(t))) + s*(x-cx)*.095*almond
                return (x, face_y(x, z)-offset, z)
            rows.append(ring(18, eye))
        face.loft(rows, ["EyeWhite", "EyeWhite", "EyeWhite", "Pupil", "Mouth", "Pupil"])
        for dx, dz, rad in ((-.007, .008, .0050), (.003, -.007, .0020)):
            x, z = cx-.003+dx, cz+dz
            face.oval((x, face_y(x, z)-.0155, z), (rad, .0019, rad),
                      "EyeWhite", 8, 4)
        def facial_stroke(samples, mat, depths, lift, steps=2):
            points = [(s*x, face_y(s*x, z)-lift, z) for x, z, w in samples]
            face.sweep(points, [p[2] for p in samples], depths, mat, sides=7,
                       normals=[(0, -1, 0)]*len(points), steps=steps)
        facial_stroke([(.021, cz-.004, .0007), (.031, cz+.012, .0018),
                       (.060, cz+.024, .0027), (.086, cz+.019, .0030),
                       (.104, cz+.005, .0015), (.108, cz+.007, .0005)],
                      "Hair", [.001, .002, .0024, .0023, .0015, .0005], .003)
        lift = .004 if s == 1 else 0
        facial_stroke([(.025, .156+lift, .0023), (.041, .164+lift, .0061),
                       (.065, .168+lift, .0068), (.084, .166+lift, .0050),
                       (.105, .155+lift, .0012)],
                      "Hair", [.002, .003, .0033, .003, .0012], .0045)
    # The smile is modelled into the curvature of the muzzle. A slim enamel
    # shape gives it an open, friendly expression even at gameplay scale.
    contours = []
    for size, offset in ((.98, -.002), (1., .002), (.90, .0032)):
        def smile(t):
            u = cos(t)
            x = .046*u*size
            z = .043 + .012*u*u + .0018*u + (.0048 if sin(t)>0 else .012)*sin(t)*size
            return (x, face_y(x, z)-offset, z)
        contours.append(ring(22, smile))
    face.loft(contours, "Mouth")
    teeth = []
    for size, offset in ((1., .0033), (.96, .0044)):
        def tooth(t):
            u = cos(t)
            x = .037*u*size
            z = .0442 + .0082*u*u + .0017*u + (.0026 if sin(t)>0 else .0023)*sin(t)*size
            return (x, face_y(x, z)-offset, z)
        teeth.append(ring(18, tooth))
    face.loft(teeth, "EyeWhite")
    return face


def make_headband():
    band = Part()
    rows = []
    for fraction, radius in ((0, -.0020), (0, .004), (.08, .0065), (.17, .0055),
                             (.77, .0057), (.86, .007), (.98, .006), (1, -.002)):
        def wrap(t):
            back = ((1-cos(t))*.5)**1.40
            z = .179 - .116*back + (.036-.010*back)*fraction
            p = head_at(t, z)
            p.x += radius*sin(t)
            p.y -= radius*cos(t)
            return p
        rows.append(ring(32, wrap))
    band.loft(rows, "Band", loop=True)
    band.oval((0, .126, .068), (.055, .022, .026), "Band", 16, 7)
    for s in (-1, 1):
        band.oval((s*.038, .125, .060), (.030, .018, .022), "Band", 12, 6)
    return band


def make_tail(s):
    tail = Part()
    k = 1. if s < 0 else .83
    pts = [(-s*.014, -.003, .022), (-s*.007, .005, .010), (s*.004, .021, -.013),
           (s*.017, .036, -.045*k), (s*.033, .040, -.076*k), (s*.047, .032, -.103*k)]
    tail.sweep(pts, [.012, .016, .020, .018, .015, .009],
               [.007, .005, .0036, .003, .0026, .0018], "Band", sides=8, steps=2)
    return tail


TORSO = [
    (-.043, .161, .107, .005), (-.037, .177, .113, .005),
    (-.024, .179, .114, .005), (.000, .175, .111, .004),
    (.055, .160, .105, .004), (.114, .154, .106, .004),
    (.174, .160, .118, .005), (.214, .173, .126, .006),
    (.251, .184, .131, .006), (.280, .190, .132, .006),
    (.320, .194, .130, .006), (.351, .185, .120, .005),
    (.375, .165, .106, .005),
]


def jersey(t, z):
    rx, ry, cy = at_profile(TORSO, z)
    return ellipse(t, z, rx, ry, 0, cy, .86)


def jersey_front(x, z):
    rx, ry, cy = at_profile(TORSO, z)
    return cy - ry*(1-(abs(x)/rx)**(2/.86))**(.86/2)


def make_jersey():
    shirt = Part()
    n = 32
    rows = [ring(n, lambda t: jersey(t, z)) for z in (-.043, -.037, -.024, .000, .058, .105)]
    # Woven-in breakers sweep upward across the chest and dip below the
    # number area at the back. Material boundaries share the same vertices.
    for dz in (-.011, -.006, .003, .034):
        def breaker(t):
            z = .166 + .042*cos(t) + .051*sin(t) + .010*sin(2*t+.3) + dz
            return jersey(t, z)
        rows.append(ring(n, breaker))
    rows.extend(ring(n, lambda t: jersey(t, z)) for z in (.280, .319, .348))

    def neckline(t):
        front = max(cos(t), 0.)
        z = .403 + .009*(1-cos(t))*.5 - .071*front**8
        return V((.070*sin(t), .005-.061*cos(t)-.052*front**5, z))

    for f in (.40, .78, .86, 1.):
        def yoke(t):
            across = jersey(t, .348)
            p = across.lerp(neckline(t), f)
            p.z += .019*sin(pi*f)*(1-max(cos(t), 0.)**3)
            return p
        rows.append(ring(n, yoke))
    # Thin inside turn at neckline, underneath the folded collar.
    rows.append([p - V((0, 0, .006)) for p in rows[-1]])
    bands = (["Shirt"]*6 + ["Stripe", "Shirt", "Stripe"] + ["Shirt"]*6 +
             ["Stripe", "Shirt"])
    shirt.loft(rows, bands)

    # Collar leaves: each changes slope from the nape to a pointed front tip.
    for s in (-1, 1):
        outline = [(s*x, y, z) for x, y, z in (
            (.010, -.112, .347), (.029, -.088, .390), (.055, -.047, .408),
            (.065, .004, .414), (.074, .038, .412), (.093, .048, .399),
            (.100, -.001, .390), (.092, -.050, .378), (.067, -.102, .340),
            (.057, -.111, .324), (.038, -.104, .360))]
        shirt.relief(outline, "Stripe", .0024, normal=(0, -.65, .76))
    # An enamel two-sail club mark, stamped into the chest above the sash.
    def badge(coords, mat, lift):
        shirt.relief([(x, jersey_front(x, z)-lift, z) for x, z in coords], mat, .0007)
    badge([(.059,.291),(.062,.310),(.078,.318),(.096,.311),(.100,.294),
           (.091,.282),(.079,.276),(.065,.282)], "Shorts", .0025)
    badge([(.065,.291),(.078,.309),(.077,.292)], "Stripe", .0045)
    badge([(.080,.292),(.081,.304),(.092,.292)], "Accent", .0045)
    badge([(.066,.289),(.093,.289),(.088,.285),(.073,.285)], "Stripe", .0045)
    # The flared neck fills the V and overlaps the head through turns.
    shirt.sections([(.318,.060,.061,0,-.040),(.336,.077,.079,0,-.022),
                    (.369,.081,.072,0,-.006),(.399,.065,.059,0,.001),
                    (.430,.055,.052,0,.003),(.455,.060,.054,0,.000),
                    (.469,.057,.049,0,-.003)], "Skin", 20)
    return shirt


def make_pelvis():
    shorts = Part()
    shorts.sections([(-.117,.071,.067),(-.103,.115,.095),(-.077,.154,.111),
                     (-.032,.169,.117),(.030,.169,.114),(.061,.163,.108),
                     (.065,.161,.107),(.070,.163,.109),(.087,.163,.109),
                     (.092,.160,.106),(.105,.154,.102)],
                    ["Shorts"]*7+["Shirt","Shorts","Shorts"], 24, .88)
    return shorts


def make_upper_arm(s):
    arm = Part()
    arm.sections([(-.301,.010,.012,0,0),(-.291,.031,.034,0,0),
                  (-.270,.043,.047,0,0),(-.248,.045,.046,s*.002,0),
                  (-.208,.046,.047,s*.007,-.002),(-.166,.053,.055,s*.011,-.002),
                  (-.119,.058,.061,s*.011,.001),(-.071,.059,.061,s*.007,.001),
                  (-.020,.054,.056,0,0)], "Skin", 16)
    # Rounded sleeve head and a separately knitted double stripe at the cuff.
    def sleeve(t, z, rx, ry, dx):
        p = ellipse(t, z, rx, ry, s*dx, .001)
        p.z += s*sin(t)*.010*clamp((-z+.012)/.128)
        return p
    rows = [ring(20, lambda t: sleeve(t, *r)) for r in (
        (-.133,.061,.061,.010),(-.130,.067,.067,.010),
        (-.124,.069,.069,.010),(-.118,.068,.069,.010),(-.112,.069,.070,.010),
        (-.103,.070,.071,.010),(-.069,.073,.075,.009),(-.029,.076,.076,.005),
        (.001,.075,.073,0),(.028,.064,.066,-.006),(.050,.044,.048,-.011),
        (.059,.020,.025,-.015))]
    arm.loft(rows, ["Shirt","Stripe","Shirt","Stripe"]+["Shirt"]*7)
    return arm


def make_forearm(s):
    arm = Part()
    arm.sections([(-.260,.021,.023,s*.003,0),(-.249,.030,.030,s*.005,0),
                  (-.221,.031,.032,s*.006,.001),(-.181,.034,.036,s*.007,0),
                  (-.130,.039,.043,s*.010,-.001),(-.078,.047,.051,s*.010,.002),
                  (-.039,.048,.049,s*.005,.002),(-.012,.045,.045,s*.001,0),
                  (.017,.039,.040,0,0),(.032,.027,.027,0,0),(.039,.011,.011,0,0)],
                 "Skin", 16)
    arm.sections([(-.234,.032,.034,s*.005,0),(-.231,.038,.039,s*.005,0),
                  (-.226,.039,.040,s*.005,0),(-.220,.037,.038,s*.005,0),
                  (-.216,.038,.039,s*.005,0),(-.189,.040,.042,s*.006,0),
                  (-.184,.041,.043,s*.006,0),(-.180,.040,.042,s*.006,0),
                  (-.176,.035,.037,s*.006,0)], ["Band"]*5+["Accent","Band","Band"], 18)
    return arm


def make_hand(s):
    hand = Part()
    hand.sections([(-.046,.014,.017,s*.016,-.004),(-.040,.026,.026,s*.016,-.005),
                   (-.026,.034,.030,s*.012,-.004),(-.003,.036,.030,s*.012,-.002),
                   (.015,.033,.028,s*.011,0),(.032,.024,.023,s*.006,0),
                   (.041,.015,.014,s*.004,0)], "Skin", 14)
    for i in range(4):
        z = .008-.014*i
        scale = (1., 1.04, .99, .82)[i]
        path = [(s*x*scale, y*scale, z+dz) for x, y, dz in (
            (.030,-.010,.002),(.032,-.026,.001),(.022,-.040,0),
            (.006,-.043,-.003),(-.007,-.036,-.005),(-.010,-.026,-.005))]
        hand.sweep(path, [.007,.0095,.0094,.0084,.0078,.004],
                   [.006,.010,.010,.009,.008,.005], "Skin", sides=7, guide=(0,0,1))
    path = [(s*x,y,z) for x,y,z in ((.010,.009,.019),(-.008,.003,.016),
            (-.020,-.010,.009),(-.022,-.025,.001),(-.014,-.037,-.004),(-.004,-.039,-.006))]
    hand.sweep(path,[.010,.016,.016,.014,.011,.005],[.009,.013,.014,.012,.010,.006],
               "Skin", sides=9, guide=(0,0,1))
    return hand


def make_thigh(s):
    leg = Part()
    leg.sections([(-.463,.013,.014,0,0),(-.449,.038,.039,0,-.001),
                  (-.427,.053,.054,0,-.002),(-.403,.057,.060,0,-.004),
                  (-.364,.056,.061,s*.002,-.002),(-.313,.062,.067,s*.003,0),
                  (-.251,.074,.081,s*.004,-.001),(-.183,.079,.086,s*.004,0),
                  (-.101,.076,.084,0,.003),(-.025,.068,.073,0,.002),
                  (.036,.052,.055,0,0),(.055,.026,.028,0,0)], "Skin", 16)
    def opening(t, z, rx, ry, dx):
        p = ellipse(t,z,rx,ry,s*dx,.003,.94)
        outside = s*sin(t)
        p.z += clamp(-z/.16) * (.008*outside + .021*max(outside,0.)**7)
        return p
    rows = [ring(22,lambda t: opening(t,*r)) for r in (
        (-.164,.085,.089,.005),(-.163,.091,.096,.005),(-.158,.092,.098,.005),
        (-.153,.092,.098,.005),(-.146,.092,.097,.005),(-.105,.095,.101,.003),
        (-.052,.097,.109,0),(.008,.095,.109,-.003),(.045,.090,.099,-.005),
        (.066,.069,.077,-.008))]
    leg.loft(rows, ["Shorts","Shorts","Stripe"]+["Shorts"]*6)
    # Curved side insert following the vent, sewn to the outside of each leg.
    pts = [(s*x,y,z) for x,y,z in ((.094,-.014,.013),(.098,-.013,-.037),
           (.098,-.017,-.076),(.094,-.030,-.110),(.088,-.034,-.132))]
    leg.sweep(pts,[.003,.004,.004,.004,.0015],[.0016]*5,"Shirt",
              sides=6,normals=[(s,0,0)]*5)
    return leg


def shoe_point(t, width, length, cy, z, s):
    fore = cos(t)
    x = width*power(sin(t),.85)*(1+.095*fore)
    y = cy-length*power(fore,.91)
    # A wider medial ball, a narrower heel and a gently turned-out toe.
    x += s*(.036*max(0.,-y) + .002*(1+fore)*.5)
    return V((x,y,z-.42))


def make_shin(s):
    shin = Part()
    # Shoe and sock profiles below use height above the court for clarity.
    shin.sections([(z-.42,rx,ry,s*dx,cy) for z,rx,ry,dx,cy in (
        (.081,.030,.032,0,.003),(.104,.035,.035,0,.003),(.162,.036,.038,.001,.006),
        (.216,.040,.045,.003,.010),(.259,.047,.054,.005,.013),
        (.298,.053,.061,.007,.014),(.331,.054,.062,.006,.012),
        (.363,.050,.054,.003,.006),(.395,.049,.051,0,-.001),
        (.421,.053,.054,0,-.004),(.444,.047,.047,0,-.003),
        (.462,.032,.033,0,0),(.469,.013,.014,0,0))], "Skin", 16)
    rows = []
    for z,rx,ry,rib in ((.068,.036,.039,0),(.100,.040,.041,.0005),
            (.146,.039,.041,.0008),(.184,.041,.045,.0011),(.191,.043,.047,.0012),
            (.197,.043,.047,.0012),(.201,.043,.047,.0012),(.208,.044,.048,.0012),
            (.214,.044,.048,.0012),(.222,.045,.049,.0012),(.227,.046,.050,.001),
            (.231,.043,.047,0)):
        def knit(t):
            ribbing = rib*cos(12*t)
            return ellipse(t,z-.42,rx+ribbing,ry+ribbing,s*.002,.007)
        rows.append(ring(24,knit))
    shin.loft(rows, ["Sock"]*4+["Shirt","Sock","Shorts"]+["Sock"]*4)

    n = 24
    rows = []
    for width,length,cy,z,roll in (
        (.053,.106,-.044,0,0),(.058,.114,-.045,0,.002),
        (.064,.119,-.046,.005,.005),(.065,.120,-.046,.014,.006),
        (.065,.119,-.046,.018,.007),(.066,.119,-.046,.020,.007),
        (.066,.118,-.046,.027,.008),(.064,.116,-.046,.038,.008)):
        rows.append(ring(n,lambda t: shoe_point(t,width,length,cy,z+roll*max(0.,cos(t))**3,s)))
    shin.loft(rows, ["Sole"]*4+["Shoe"]*3)
    # Leather upper, rubber toe guard, heel counter and a dark collar opening.
    rows = []
    for width,length,cy,z,heel in (
        (.063,.115,-.046,.036,.005),(.062,.115,-.046,.043,.006),
        (.061,.111,-.045,.049,.010),(.058,.102,-.042,.056,.021),
        (.054,.087,-.035,.063,.032),(.046,.065,-.016,.075,.032),
        (.043,.055,-.004,.087,.030),(.042,.050,.001,.096,.023),
        (.038,.045,.001,.095,.019),(.033,.039,.001,.087,.019)):
        rows.append(ring(n,lambda t: shoe_point(t,width,length,cy,z+heel*(1-cos(t))*.5,s)))
    shin.loft(rows, ["Shoe","Sock","Shoe","Shoe","Shoe","Shoe","Shoe","Shorts","Shorts"])
    # Padded tongue and four laces rise up the instep.
    up = V((0,.65,.76))
    forward = V((0,-.76,.65))
    shin.oval((s*.004,-.067,.083-.42),(.032,.012,.055),"Shirt",14,6,
              axes=((1,0,0),forward,up))
    for i in range(4):
        y, z = -.102+i*.014,.067+i*.0105
        w = .023-i*.001
        pts = [(s*.004+x, y+dy, z+dz-.42) for x,dy,dz in
               ((-w,.003,-.003),(-w*.60,0,.003),(0,-.001,.005),(w*.6,-.002,.003),(w,-.004,-.003))]
        shin.sweep(pts,[.0024,.0031,.0032,.0031,.0024],[.0025]*5,
                   "Shoe",sides=6,normals=[(0,-.5,.86)]*5)
    # A lateral wave stripe follows the last, with an inset coral heel tab.
    wave = [(s*x,y,z-.42) for x,y,z in (
        (.058,-.105,.048),(.063,-.079,.051),(.065,-.048,.059),
        (.059,-.017,.068),(.053,.012,.083),(.039,.044,.090))]
    shin.sweep(wave,[.0014,.0044,.005,.005,.004,.0015],
               [.0015,.0025,.003,.003,.0025,.0015],"Shorts",sides=7,
               normals=[(s,0,0)]*6)
    heel = [(0,.067,.047-.42),(0,.064,.068-.42),(0,.057,.092-.42),(0,.053,.111-.42)]
    shin.sweep(heel,[.012,.011,.010,.009],[.003,.004,.004,.003],
               "Shirt",sides=7)
    return shin


def hair_surface(style, t, u):
    front = (1+cos(t))*.5
    edge = .103+.107*front**1.65
    if style == "Classic":
        edge += .008*sin(t+.2)-.008*sin(3*t+.4)*front
    elif style == "Ponytail":
        edge += .004+.007*cos(2*t+.3)
    elif style == "Mohawk":
        edge -= .010+.006*cos(2*t)
    elif style == "Curly":
        edge += .008*sin(9*t+.35)+.004*cos(5*t)-.003
    elif style == "Bob":
        edge = .029 + .190*max(0.,cos(t))**3.1 + .009*sin(5*t+.6)
    a = sin(clamp(u,-.12,1.)*pi/2)
    z = mix(edge,.280,a)
    rx, ry, cy = at_profile(HEAD,z)
    if style == "Bob":
        skirt = clamp((.148-z)/.090)
        rx = mix(rx,max(rx,.153),skirt)
        ry = mix(ry,max(ry,.138),skirt)
    swell = {"Classic":.010,"Ponytail":.005,"Mohawk":.0034,"Curly":.016,"Bob":.011}[style]
    ripple = 0
    if style == "Curly":
        ripple = .0053*(cos(9*t+7*u)+.6*sin(6*t-11*u))*(1-u)
    lift = {"Classic":.024,"Ponytail":.012,"Mohawk":.007,"Curly":.033,"Bob":.018}[style]
    dr = (swell+ripple)*max(0.,1-u**3)
    xshift = -.020*a**2 if style == "Classic" else .008*a*a if style == "Bob" else 0
    p = ellipse(t,z+lift*a,rx+dr,ry+dr,xshift,cy+.004*a,.91)
    if style == "Classic":
        p.z += .010*max(0.,cos(t+.5))*sin(pi*clamp(u))
    return p


def scalp_frame(style,t,u):
    p = hair_surface(style,t,u)
    dt = hair_surface(style,t+.003,u)-hair_surface(style,t-.003,u)
    du = hair_surface(style,t,u+.002)-hair_surface(style,t,u-.002)
    return p, dt.cross(du).normalized()


def hair_shell(part,style,n=26):
    rim = ring(n,lambda t: hair_surface(style,t,0))
    rows = [[V((p.x*.93,p.y*.93,p.z+.002)) for p in rim],rim]
    for u in (.068,.19,.34,.51,.68,.84,.96,1.):
        rows.append(ring(n,lambda t: hair_surface(style,t,u)))
    part.loft(rows,"Hair")


def ridge(part,style,stations,widths,depths, *, steps=1):
    pts, normals = [], []
    for t,u in stations:
        p, n = scalp_frame(style,t,u)
        pts.append(p-n*.0013)
        normals.append(n)
    part.sweep(pts,widths,depths,"Hair",sides=8,normals=normals,steps=steps)


def make_classic():
    hair = Part()
    hair_shell(hair,"Classic",28)
    # The crown flows out of an off-centre part. Each broad ribbon narrows
    # into a point at the temple, like a single carved, swept-back lock.
    for i in range(5):
        t = -1.36+i*.49
        stations = [(t-.33,-.065+.010*i),(t-.18,.055),(t+.03,.20),
                    (t+.30,.40),(t+.52,.59),(t+.68,.74)]
        ridge(hair,"Classic",stations,[.0025,.017,.025,.025,.017,.003],
              [.002,.008,.013,.011,.006,.002],steps=2)
    for t,s in ((-1.45,-1),(1.30,1),(2.15,1),(-2.22,-1)):
        ridge(hair,"Classic",[(t,.03),(t+s*.17,.19),(t+s*.37,.34),(t+s*.53,.51)],
              [.002,.015,.017,.003],[.002,.006,.007,.002])
    return hair


def make_ponytail():
    hair = Part()
    hair_shell(hair,"Ponytail")
    for s in (-1,1):
        for k in range(2):
            t = s*(.45+.58*k)
            ridge(hair,"Ponytail",[(t,.03),(t+s*.40,.26),(t+s*.95,.46),
                  (t+s*1.42,.40),(s*(2.80-.07*k),.26)],
                  [.002,.012,.017,.016,.002],[.001,.004,.005,.005,.002],steps=2)
    hair.oval((.008,.143,.171),(.047,.036,.041),"Hair",14,7)
    plume = [(.009,.143,.166),(.009,.176,.182),(.013,.201,.184),(.024,.229,.164),
             (.033,.248,.126),(.047,.257,.088),(.064,.262,.060),(.081,.272,.054)]
    hair.sweep(plume,[.022,.033,.043,.049,.042,.031,.016,.002],
               [.020,.032,.039,.043,.036,.024,.010,.002],"Hair",sides=14,steps=2)
    for s in (-1,1):
        strand = [(x+s*dx,y+dy,z+dz) for (x,y,z),dx,dy,dz in zip(
            plume[2:],(.021,.027,.025,.017,.009,0),(.003,.015,.015,.011,.005,0),
            (.024,.020,.009,.002,.001,0))]
        hair.sweep(strand,[.004,.014,.013,.010,.006,.0015],
                   [.004,.012,.010,.008,.004,.0015],"Hair",sides=7)
    # Tie is wound across the narrow throat, before the pony flares out.
    hair.sweep([(.009,.149,.173),(.009,.155,.175),(.009,.166,.180),(.010,.171,.181)],
               [.035,.037,.036,.034],[.030,.032,.032,.030],"Band",sides=16)
    return hair


def make_mohawk():
    hair = Part()
    hair_shell(hair,"Mohawk",24)
    # A single saw-toothed dorsal silhouette with a rolled, bevelled edge.
    profile = [(-.133,.214,.226,.009),(-.121,.223,.259,.026),
               (-.102,.241,.294,.031),(-.079,.254,.320,.034),
               (-.060,.267,.300,.033),(-.033,.269,.334,.035),
               (-.010,.275,.313,.034),(.023,.276,.337,.033),
               (.043,.269,.310,.034),(.079,.254,.322,.032),
               (.090,.244,.291,.027),(.123,.219,.288,.025),
               (.136,.197,.250,.021),(.148,.177,.220,.016),(.147,.147,.163,.007)]
    rows = []
    for y,bottom,top,w in profile:
        drift = .009*(y+.13)/.28
        rows.append([V((drift+w*dx,y+(top-bottom)*lean,bottom+(top-bottom)*h))
                     for dx,h,lean in ((-.66,0,0),(-1,.20,.03),(-.80,.55,.08),
                     (-.25,.94,.14),(0,1,.16),(.27,.93,.14),(.81,.55,.08),
                     (1,.20,.03),(.66,0,0),(0,-.04,0))])
    hair.loft(rows,"Hair")
    for s in (-1,1):
        for k in range(2):
            ridge(hair,"Mohawk",[(s*(1.04+k*.42),.04),(s*(1.24+k*.43),.20),
                  (s*(1.64+k*.42),.36),(s*(1.94+k*.42),.46)],
                  [.002,.008,.009,.0015],[.001,.003,.003,.001])
    return hair


def make_curly():
    hair = Part()
    hair_shell(hair,"Curly",32)
    # Interlocking C-shaped curls sit tangential to a scalloped crown. The
    # second course is staggered so the parting never becomes a latitude line.
    for count,level,phase,extent in ((10,.13,.10,.27),(8,.40,.46,.31),(5,.67,.13,.36)):
        for i in range(count):
            t = TAU*(i+phase)/count
            u = level+.027*sin(i*2.3+level)
            stations = [(t-extent*.45,u-.14),(t-extent,u-.055),(t-extent*.85,u+.065),
                        (t,u+.14),(t+extent*.80,u+.10),(t+extent,u+.02),
                        (t+extent*.47,u-.014)]
            ridge(hair,"Curly",stations,[.003,.012,.018,.021,.017,.012,.004],
                  [.003,.010,.014,.016,.013,.009,.003])
    return hair


def make_bob():
    hair = Part()
    hair_shell(hair,"Bob",32)
    for s in (-1,1):
        for i in range(4):
            t = s*(.88+i*.46)
            stations = [(t+s*.10,-.065+.02*(i%2)),(t,.035),(t-s*.04,.17),
                        (t-s*.16,.36),(t-s*.32,.57),(t-s*.70,.76)]
            ridge(hair,"Bob",stations,[.002,.012,.018,.023,.019,.0025],
                  [.002,.007,.008,.010,.007,.002],steps=2 if i<2 else 1)
    ridge(hair,"Bob",[(-.87,-.06),(-.69,.035),(-.38,.12),(.04,.24),(.46,.48),(.73,.67)],
          [.002,.016,.022,.026,.021,.002],[.0015,.006,.008,.010,.008,.002],steps=2)
    return hair


def hat_band(part,kind,body,trim):
    rows = []
    for f,bulge in ((0,-.006),(0,.001),(.10,.003),(.18,.002),
                    (.77,.002),(.86,.003),(1,.001),(1,-.006)):
        def band(t):
            front = (1+cos(t))*.5
            low = .145+.040*front
            height = .032 if kind == "Visor" else .040
            if kind == "Captain":
                low += .003
            w = .166 + (.005 if kind=="Captain" else 0)
            d = .151 + (.004 if kind=="Captain" else 0)
            return ellipse(t,low+height*f,w+bulge,d+bulge,0,.005,.94)
        rows.append(ring(36,band))
    part.loft(rows,[body,trim,trim,body,body,trim,body,body],loop=True)


def bill(part,kind):
    main,edge = ("Shorts","Shorts") if kind=="Captain" else ("Accent","Stripe")
    rows = []
    for i in range(27):
        t = mix(-1.30,1.30,i/26)
        front = cos(t)
        reach = (.089 if kind=="Visor" else .077 if kind=="Cap" else .067) * max(.0,1-(abs(t)/1.33)**2)**.64
        reach += .002
        x = .165*sin(t)
        y = .006-.144*cos(t)
        base_z = .175+.014*front
        if kind=="Captain":
            base_z += .005
        def lip(f,h):
            return V((x+reach*.53*sin(t)*f, y-reach*cos(t*.55)*f,
                      base_z+(.005*sin(pi*f)-.027*f)*front-.008*sin(t)**2*f+h))
        rows.append([lip(f,h) for f,h in ((0,0),(.30,.002),(.70,.002),(.93,.001),
                     (1,0),(1,-.0035),(.92,-.005),(.60,-.005),(.18,-.004),(0,-.003))])
    # Most of the binding follows the outside edge across the bill, so assign
    # it around the section rather than between successive angular stations.
    start = len(part.faces)
    part.loft(rows,main)
    for j in range(len(rows)-1):
        for index in (4,5):
            part.shader[start+j*10+index] = edge


def hat_logo(part,kind):
    y = -.150 if kind == "Captain" else -.145
    z = .211 if kind == "Captain" else .204
    if kind == "Captain":
        outline = [(-.022,.008),(-.014,.020),(0,.024),(.014,.020),(.022,.008),
                   (.016,-.010),(0,-.019),(-.016,-.010)]
        part.relief([(x,y-.005,z+q) for x,q in outline],"Accent",.0017)
        part.relief([(x*.81,y-.0075,z+q*.81) for x,q in outline],"Shorts",.0012)
        for pts in ([(0,-.005),(0,.010)],[(-.005,.005),(.005,.005)],
                    [(-.010,-.001),(-.007,-.006),(0,-.010),(.007,-.006),(.010,-.001)]):
            part.sweep([(x,y-.010,z+q) for x,q in pts],[.0016]*len(pts),
                       [.0013]*len(pts),"Accent",sides=6,normals=[(0,-1,0)]*len(pts))
    else:
        # Repeat the two asymmetric sails from the jersey.
        for tri in (((-.014,-.006),(-.001,.010),(-.002,-.006)),
                    ((.002,-.006),(.003,.005),(.012,-.006))):
            part.relief([(x,y-.003,z+q) for x,q in tri],"Stripe",.0015)


def make_visor():
    hat = Part()
    hat_band(hat,"Visor","Accent","Stripe")
    bill(hat,"Visor")
    hat_logo(hat,"Visor")
    return hat


CAP = [(.193,.166,.151,.006),(.215,.169,.154,.007),(.240,.167,.153,.008),
       (.265,.158,.147,.010),(.289,.144,.133,.012),(.310,.122,.112,.015),
       (.327,.092,.083,.016),(.338,.055,.048,.017),(.342,.014,.014,.017)]


def cap_at(t,z):
    rx,ry,cy = at_profile(CAP,z)
    taper = clamp((.28-z)/.09)
    return ellipse(t,z-.022*(1-cos(t))*.5*taper,rx,ry,0,cy,.94)


def make_cap():
    hat = Part()
    hat_band(hat,"Cap","Accent","Stripe")
    hat.loft([ring(32,lambda t: cap_at(t,z)) for z,*_ in CAP],"Accent")
    bill(hat,"Cap")
    for i in range(6):
        t = (i+.5)*TAU/6
        pts = []
        for z in (.209,.239,.265,.289,.311,.327,.337,.341):
            p = cap_at(t,z)
            p += V((sin(t),-cos(t),.35))*.001
            pts.append(p)
        hat.sweep(pts,[.0018]*8,[.0015]*8,"Stripe",sides=6,
                  normals=[(sin(t),-cos(t),.5)]*8)
    hat.oval((0,.017,.343),(.014,.014,.006),"Accent",12,5)
    hat_logo(hat,"Cap")
    return hat


def make_captain():
    hat = Part()
    hat_band(hat,"Captain","Shorts","Accent")
    rows = []
    for z,rx,ry,cy,tilt in (
        (.194,.166,.153,.004,.019),(.211,.173,.160,.003,.021),
        (.221,.185,.171,.001,.022),(.241,.198,.181,-.002,.021),
        (.262,.200,.184,-.003,.018),(.277,.195,.178,-.003,.015),
        (.292,.178,.165,-.003,.012),(.315,.148,.139,.000,.008),
        (.337,.105,.098,.004,.003),(.348,.053,.048,.005,0),(.350,.010,.010,.005,0)):
        rows.append(ring(32,lambda t: ellipse(t,z+tilt*cos(t),rx,ry,0,cy,.90)))
    hat.loft(rows,["Stripe"]*2+["Stripe"]*8)
    bill(hat,"Captain")
    # Two interlaced strands, held above the peak by domed brass buttons.
    for phase in (0,pi):
        pts = []
        for i in range(35):
            t = mix(-1.20,1.20,i/34)
            twist = TAU*5*i/34+phase
            r = .0021*cos(twist)
            pts.append(V(((.175+r)*sin(t),.004-(.159+r)*cos(t),
                          .192-.010*cos(t)+.0021*sin(twist))))
        hat.sweep(pts,[.0025]*35,[.0025]*35,"Accent",sides=6,guide=(0,0,1))
    for s in (-1,1):
        hat.oval((s*.160,-.055,.189),(.009,.009,.010),"Accent",10,5)
    hat_logo(hat,"Captain")
    return hat


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATERIALS.clear()
    for key, (col, rough) in PALETTE.items():
        MATERIALS[key] = material("Mat_" + key, col, rough)


def build_player():
    pivots = {}
    for name, (parent_name, loc) in PIVOTS.items():
        parent = pivots[parent_name] if parent_name else None
        pivots[name] = empty(name, parent, loc)

    objs = list(pivots.values())
    objs.append(make_pelvis().object("Pelvis_Mesh", pivots["Pelvis"]))
    objs.append(make_jersey().object("Chest_Mesh", pivots["Chest"]))
    objs.append(make_portrait().object("Head_Mesh", pivots["Head"]))
    objs.append(make_expression().object("Face_Mesh", pivots["Head"]))
    objs.append(make_headband().object("Headband_Mesh", pivots["Head"]))
    objs.append(make_tail(-1).object("HeadbandTail_L_Mesh", pivots["HeadbandTail_L"]))
    objs.append(make_tail(1).object("HeadbandTail_R_Mesh", pivots["HeadbandTail_R"]))

    for side, sign in (("L", 1), ("R", -1)):
        objs.append(make_upper_arm(sign).object(f"UpperArm_{side}_Mesh", pivots[f"UpperArm_{side}"]))
        objs.append(make_forearm(sign).object(f"Forearm_{side}_Mesh", pivots[f"Forearm_{side}"]))
        objs.append(make_hand(sign).object(f"Hand_{side}_Mesh", pivots[f"Hand_{side}"]))
        objs.append(make_thigh(sign).object(f"Thigh_{side}_Mesh", pivots[f"Thigh_{side}"]))
        objs.append(make_shin(sign).object(f"Shin_{side}_Mesh", pivots[f"Shin_{side}"]))
    return pivots, objs


def build_accessories():
    builders = {
        "Hair_Classic": make_classic,
        "Hair_Ponytail": make_ponytail,
        "Hair_Mohawk": make_mohawk,
        "Hair_Curly": make_curly,
        "Hair_Bob": make_bob,
        "Hat_Visor": make_visor,
        "Hat_Cap": make_cap,
        "Hat_Captain": make_captain,
    }
    return [builders[name]().object(name) for name in WARDROBE]


def export_glb(objects, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
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
    print(f"[GLB] {path.name}: {len(data)/1024:.1f} KB | nodes={len(nodes)} | mats={mats}")
    return meta


def setup_cycles_studio(res=(900, 1080), samples=24):
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

    world = bpy.data.worlds.new("StudioWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.62, 0.78, 0.85, 1.0)
    bg.inputs["Strength"].default_value = 0.75

    def add_light(name, kind, loc, rot, energy, color=(1, 1, 1), size=2.0):
        ldata = bpy.data.lights.new(name, type=kind)
        ldata.energy = energy
        ldata.color = color
        if kind == "AREA":
            ldata.size = size
        elif kind == "SUN":
            ldata.angle = math.radians(4.0)
        lobj = bpy.data.objects.new(name, ldata)
        scene.collection.objects.link(lobj)
        lobj.location = loc
        lobj.rotation_euler = rot
        return lobj

    add_light("KeySun", "SUN", (3, -4, 5), (math.radians(52), math.radians(12), math.radians(32)), 3.2, (1.0, 0.95, 0.86))
    add_light("FillArea", "AREA", (-2.6, -2.5, 2.2), (math.radians(65), 0, math.radians(-48)), 95, (0.72, 0.90, 1.0), 2.5)
    add_light("RimArea", "AREA", (1.2, 2.8, 2.4), (math.radians(-62), 0, math.radians(160)), 140, (1.0, 0.90, 0.74), 2.2)

    bpy.ops.mesh.primitive_plane_add(size=18, location=(0, 0, 0))
    floor = bpy.context.active_object
    fmat = material("StudioFloor", "e8e2d5", 0.78)
    floor.data.materials.append(fmat)


def add_camera(loc, target, lens=52):
    cdata = bpy.data.cameras.new("Cam")
    cdata.lens = lens
    cobj = bpy.data.objects.new("Cam", cdata)
    bpy.context.scene.collection.objects.link(cobj)
    cobj.location = V(loc)
    direction = V(target) - V(loc)
    cobj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cobj
    return cobj


def render_previews():
    PREVIEWS.mkdir(parents=True, exist_ok=True)

    # 1. Front & Back 3/4 character studio renders (wearing Hair_Classic)
    clear_scene()
    pivots, _ = build_player()
    make_classic().object("Hair_Classic_Preview", pivots["Head"])
    # Subtle natural relaxed pose ONLY for preview photography (arms angled slightly out & forward)
    pivots["UpperArm_L"].rotation_euler = (math.radians(-10), math.radians(-14), 0)
    pivots["Forearm_L"].rotation_euler = (math.radians(-22), 0, 0)
    pivots["UpperArm_R"].rotation_euler = (math.radians(-10), math.radians(14), 0)
    pivots["Forearm_R"].rotation_euler = (math.radians(-22), 0, 0)
    pivots["Head"].rotation_euler = (0, 0, math.radians(-6))
    setup_cycles_studio((840, 1080), samples=24)

    cam = add_camera((-1.15, -2.55, 1.18), (0, 0, 0.90), lens=52)
    bpy.context.scene.render.filepath = str(PREVIEWS / "player_front_3q.png")
    bpy.ops.render.render(write_still=True)

    cam.location = V((1.20, 2.50, 1.22))
    cam.rotation_euler = (V((0, 0, 0.92)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.render.filepath = str(PREVIEWS / "player_back_3q.png")
    bpy.ops.render.render(write_still=True)

    # 2. All 8 accessories on mannequin heads (2x4 grid)
    clear_scene()
    setup_cycles_studio((1400, 780), samples=20)
    builders = {
        "Hair_Classic": make_classic, "Hair_Ponytail": make_ponytail,
        "Hair_Mohawk": make_mohawk, "Hair_Curly": make_curly,
        "Hair_Bob": make_bob, "Hat_Visor": make_visor,
        "Hat_Cap": make_cap, "Hat_Captain": make_captain,
    }
    for idx, name in enumerate(WARDROBE):
        col = idx % 4
        row = idx // 4
        x = (col - 1.5) * 0.46
        z = 0.56 - row * 0.46
        holder = empty(f"Slot_{name}", None, (x, 0, z))
        holder.rotation_euler = (0, 0, math.radians(-20 if col < 2 else 20))
        make_portrait().object(f"Head_{name}", holder)
        make_expression().object(f"Face_{name}", holder)
        builders[name]().object(f"Acc_{name}", holder)
    add_camera((0, -2.75, 0.50), (0, 0, 0.44), lens=46)
    bpy.context.scene.render.filepath = str(PREVIEWS / "accessories_lineup.png")
    bpy.ops.render.render(write_still=True)


def main():
    TMP.mkdir(parents=True, exist_ok=True)
    # 1. Export clean neutral-pose tennis_player.glb
    clear_scene()
    pivots, objs = build_player()
    meta = export_glb(objs, MODELS / "tennis_player.glb")
    node_names = {n.get("name") for n in meta.get("nodes", [])}
    missing = [k for k in PIVOTS if k not in node_names]
    assert not missing, f"Missing pivots in GLB: {missing}"

    # 2. Export clean head-local accessories.glb
    clear_scene()
    acc_objs = build_accessories()
    ameta = export_glb(acc_objs, MODELS / "accessories.glb")
    anode_names = {n.get("name") for n in ameta.get("nodes", [])}
    amissing = [w for w in WARDROBE if w not in anode_names]
    assert not amissing, f"Missing wardrobe items in GLB: {amissing}"

    # 3. Render Cycles CPU previews
    render_previews()
    print("[OK] Character & accessories exported and rendered cleanly.")


if __name__ == "__main__":
    main()
