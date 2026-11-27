"""Build Lagoon Open's meter-scale equipment and photograph the exported GLBs.

Run with Blender 5.3 in background mode. All meshes, finishes and artwork are
generated here, including the embedded veneer, twill and intaglio plaque maps.
"""

import json
import math
from pathlib import Path
import struct
import tempfile
import zlib
from dataclasses import dataclass
from math import cos, pi, sin, sqrt, tau

import bpy
import numpy as np
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public" / "models"
PREVIEWS = ROOT / "tools" / "blender" / "previews" / "rackets"
Z_AXIS = Vector((0, 0, 1))
Y_AXIS = Vector((0, 1, 0))


def srgb(code):
    rgb = [int(code[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
                 for v in rgb)


def finish(name, color, metal=0.0, rough=0.38, coat=0.0, emission=0.0,
           image=None, rough_map=None, normal_map=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*srgb(color), 1)
    mat.use_nodes = True
    tree = mat.node_tree
    shader = tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Metallic"].default_value = metal
    shader.inputs["Roughness"].default_value = rough
    shader.inputs["Coat Weight"].default_value = coat
    shader.inputs["Coat Roughness"].default_value = 0.20
    if emission:
        shader.inputs["Emission Color"].default_value = mat.diffuse_color
        shader.inputs["Emission Strength"].default_value = emission
    for texture, socket in ((image, "Base Color"), (rough_map, "Roughness"),
                            (normal_map, "Normal")):
        if texture is None:
            continue
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = texture
        output = node.outputs["Color"]
        if socket == "Normal":
            normal = tree.nodes.new("ShaderNodeNormalMap")
            tree.links.new(output, normal.inputs["Color"])
            output = normal.outputs["Normal"]
        tree.links.new(output, shader.inputs[socket])
    return mat


def packed_png(directory, name, data, data_map=False):
    """Write explicit 8-bit PNG values so color and data maps survive export."""
    rgb = np.ascontiguousarray(np.clip(data, 0, 255), dtype=np.uint8)
    if rgb.ndim == 2:
        rgb = np.repeat(rgb[:, :, None], 3, axis=2)
    h, w, _ = rgb.shape

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))

    rows = b"".join(b"\0" + row.tobytes() for row in rgb)
    path = directory / (name + ".png")
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))
    img = bpy.data.images.load(str(path))
    if data_map:
        img.colorspace_settings.name = "Non-Color"
    img.pack()
    return img


def surface_maps(directory):
    y, x = np.mgrid[0:256, 0:256] / 256.0
    rng = np.random.default_rng(1978)
    noise = rng.normal(0, 1, x.shape)
    phase = x + 0.029 * np.sin(tau * y) + 0.010 * np.sin(tau * (2 * y + x))
    rings = np.sin(tau * (16 * phase + .45 * np.sin(tau * 3 * phase)))
    grain = (0.45 + .20 * rings + .15 * np.sin(tau * 61 * phase)
             + .13 * np.sin(tau * (4 * phase + y)) + .045 * noise)

    def blend(a, b, amount):
        return np.array(a) + (np.array(b) - a) * np.clip(amount[..., None], 0, 1)

    twill_x, twill_y = 24 * x, 24 * y
    over = (np.floor(twill_x) - np.floor(twill_y)) % 4 < 2
    thread = np.where(over, twill_x, twill_y)
    yarn = .5 - .5 * np.cos(tau * thread)
    filaments = .5 + .5 * np.cos(tau * 4 * thread)
    carbon = .13 + .20 * over + .49 * yarn + .10 * filaments + .027 * noise
    brush = 79 + 7 * np.sin(tau * 83 * x) + 5 * np.sin(tau * (44 * x + y)) + 3 * noise
    return {
        "teak": packed_png(directory, "Quarter-sawn teak",
                           blend((91, 46, 28), (196, 133, 77), grain)),
        "mahogany": packed_png(directory, "Ribbon mahogany",
                               blend((62, 29, 23), (133, 68, 43), grain)),
        "carbon": packed_png(directory, "Two over two graphite twill",
                             blend((28, 34, 40), (74, 83, 88), carbon)),
        "brush": packed_png(directory, "Longitudinal satin brushing", brush, True),
    }


class Mesh:
    """Indexed surfaces with per-corner UVs. Each asset has one identity node."""

    def __init__(self):
        self.vertices = []
        self.faces = []
        self.face_materials = []
        self.uvs = []
        self.smooth = []
        self.materials = []

    def vertex(self, xyz):
        self.vertices.append(tuple(xyz))
        return len(self.vertices) - 1

    def face(self, ids, mat, uv=None, smooth=True):
        self.faces.append(tuple(ids))
        if mat not in self.materials:
            self.materials.append(mat)
        self.face_materials.append(self.materials.index(mat))
        self.uvs.extend(uv if uv is not None else [(0, 0)] * len(ids))
        self.smooth.append(smooth)

    def make(self, name):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices, [], self.faces, shade_flat=False)
        mesh.update()
        for mat in self.materials:
            mesh.materials.append(mat)
        mesh.polygons.foreach_set("material_index", self.face_materials)
        mesh.polygons.foreach_set("use_smooth", self.smooth)
        uv = mesh.uv_layers.new(name="Finish UV")
        uv.uv.foreach_set("vector", np.asarray(self.uvs, dtype=np.float32).ravel())
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def join_rings(mesh, rings, material, *, closed=False, caps=False, reverse=False,
               uv_scale=(1, 1)):
    """Loft rings with a UV seam. Rows run along the length of the surface."""
    count, sides = len(rings), len(rings[0])
    spans = count if closed else count - 1
    for i in range(spans):
        a, b = rings[i], rings[(i + 1) % count]
        for j in range(sides):
            k = (j + 1) % sides
            ids = (a[j], b[j], b[k], a[k])
            u0, u1 = uv_scale[0] * j / sides, uv_scale[0] * (j + 1) / sides
            v0, v1 = uv_scale[1] * i / spans, uv_scale[1] * (i + 1) / spans
            uv = ((u0, v0), (u0, v1), (u1, v1), (u1, v0))
            mat = material(i, j) if callable(material) else material
            mesh.face(ids[::-1] if reverse else ids, mat, uv[::-1] if reverse else uv)
    if caps and not closed:
        for i, flip in ((0, reverse), (-1, not reverse)):
            mat = material(0 if i == 0 else spans - 1, 0) if callable(material) else material
            mesh.face(rings[i][::-1] if flip else rings[i], mat, smooth=False)


def lathe(mesh, levels, sides, *, offset=0, center=(0, 0), flutes=0, caps=True):
    """Levels are (z, radius, material [, flute depth])."""
    rings = []
    for z, radius, _mat, *extra in levels:
        ring = []
        for j in range(sides):
            a = offset + tau * j / sides
            r = radius + (extra[0] * (.5 + .5 * cos(flutes * a)) if extra else 0)
            ring.append(mesh.vertex((center[0] + r * cos(a), center[1] + r * sin(a), z)))
        rings.append(ring)
    join_rings(mesh, rings, lambda i, j: levels[i][2], reverse=True, caps=caps)


LENS = ((1, -.43), (1, .43), (.66, .92), (-.62, 1),
        (-1, .45), (-1, -.45), (-.62, -1), (.66, -.92))


def sweep_xz(mesh, path, profile, material, *, y=0, caps=True):
    """Radii can change independently in the face and edge directions."""
    rings = []
    for i, (x, z, width, depth) in enumerate(path):
        prev, after = path[max(0, i - 1)], path[min(i + 1, len(path) - 1)]
        dx, dz = after[0] - prev[0], after[1] - prev[1]
        length = math.hypot(dx, dz)
        nx, nz = -dz / length, dx / length
        rings.append([mesh.vertex((x + nx * w * width, y + d * depth, z + nz * w * width))
                      for w, d in profile])
    join_rings(mesh, rings, material, caps=caps, uv_scale=(1, 2))


def round_section(sides):
    return [(cos(tau * j / sides), sin(tau * j / sides)) for j in range(sides)]


def tube(mesh, points, radius, material, sides=5, reference=Y_AXIS, closed=False):
    """Parallel reference is fixed for planar paths such as wire and relief."""
    rings = []
    for i, point in enumerate(points):
        prev = points[(i - 1) % len(points) if closed else max(0, i - 1)]
        after = points[(i + 1) % len(points) if closed else min(len(points) - 1, i + 1)]
        tangent = (Vector(after) - Vector(prev)).normalized()
        u = tangent.cross(reference).normalized()
        v = u.cross(tangent)
        rings.append([mesh.vertex(Vector(point) + radius * (a * u + b * v))
                      for a, b in round_section(sides)])
    join_rings(mesh, rings, material, closed=closed)


@dataclass(frozen=True)
class Racket:
    key: str
    title: str
    frame: str
    trim: str
    foil: str
    grip: str
    seam: str
    string: str
    rx: float
    pear: float
    beam: float
    depth: float


RACKETS = (
    Racket("classic", "Lagoon Classic", "F3DDAA", "164F47", "D4AA69", "AF724B",
           "70432F", "F7EBCF", .1278, .043, .0067, .0091),
    Racket("coral", "Coral Pro", "FF563E", "075659", "FFE6C1", "23292D",
           "121A20", "FAFDFF", .1270, .072, .0072, .0115),
    Racket("carbon", "Aero Carbon", "3D494D", "13DDEE", "B6D9DC", "303A40",
           "141F25", "E2E7E7", .1274, .024, .0069, .0106),
    Racket("gold", "Sol Champion", "DCB574", "FFF2DF", "AF792E", "EBDDC5",
           "BDA98D", "EED39B", .1268, .036, .0076, .0100),
    Racket("flame", "Volcanic Legend", "352D34", "FF851E", "E9A954", "372D32",
           "1E1A20", "E9D4BA", .1248, .060, .0074, .0109),
)


def racket_finishes(s, maps):
    frame = finish("Mat_" + s.title.replace(" ", ""), s.frame,
                   metal={"classic": .10, "coral": .24, "carbon": .55,
                          "gold": .86, "flame": .70}[s.key],
                   rough=.265, coat=.43, image=maps["carbon"] if s.key == "carbon" else None,
                   rough_map=maps["brush"] if s.key == "gold" else None)
    trim = finish("Mat_" + s.key + "_Inlay", s.trim, metal=.38, rough=.27, coat=.25,
                  emission={"carbon": .60, "flame": 1.4}.get(s.key, 0))
    foil = finish("Mat_" + s.key + "_Foil", s.foil, metal=.65, rough=.25, coat=.15)
    throat = {"classic": finish("Mat_OiledTeak", "AD7649", rough=.31, coat=.37,
                                image=maps["teak"]),
              "coral": trim, "carbon": frame, "gold": foil, "flame": frame}[s.key]
    return dict(body=frame, trim=trim, foil=foil, throat=throat,
                grip=finish("Mat_" + s.key + "_Wrap", s.grip, rough=.61, coat=.06),
                groove=finish("Mat_" + s.key + "_Skive", s.seam, rough=.69),
                guard=finish("Mat_" + s.key + "_Bumper", "303334" if s.key == "gold"
                             else "202B31", rough=.51),
                strings=finish("Mat_Strings", s.string, metal=.06, rough=.34, coat=.19))


def head_point(s, t):
    c, v = cos(t), sin(t)
    dx, dz = s.rx * (c + s.pear * (c * c - v * v)), -.161 * v
    length = math.hypot(dx, dz)
    return (s.rx * v * (1 + s.pear * c), .517 + .161 * c,
            -dz / length, dx / length)


def section_point(s, t, w, d):
    x, z, nx, nz = head_point(s, t)
    # A little more mass at the shoulders, a finer, faster beam at the crown.
    width = s.beam * (1 - .09 * cos(t))
    return Vector((x + nx * w * width, d * s.depth, z + nz * w * width))


# The first facet is the floor of the recessed bumper channel. The two lips
# sit radially proud of it. At six o'clock the inside wall is the throat bridge.
HOOP = ((.81, -.27), (.81, .27), (1, .44), (.82, .82), (.39, 1),
        (-.52, .96), (-1, .50), (-1, -.50), (-.52, -.96), (.39, -1),
        (.82, -.82), (1, -.44))
HEAD_STEPS = 48


def head(mesh, s, m):
    rings, inner = [], []
    for i in range(HEAD_STEPS):
        t = tau * i / HEAD_STEPS
        rings.append([mesh.vertex(section_point(s, t, w, d)) for w, d in HOOP])
        p = section_point(s, t, -1, 0)
        inner.append((p.x, p.z))

    def color(i, j):
        t = abs((tau * (i + .5) / HEAD_STEPS + pi) % tau - pi)
        if t < 1.32 and j in (11, 0, 1):
            return m["guard"]
        if s.key in ("gold", "flame") and j in (5, 6, 7):
            return m["trim"] if j != 6 or s.key == "gold" else m["foil"]
        if s.key == "classic" and j in (5, 7):
            return m["trim"]
        if s.key == "coral" and (t > 2.64 or (j == 6 and t > 1.9)):
            return m["trim"]
        if s.key == "carbon" and j in (5, 7) and (.59 < t < 1.35 or t > 2.79):
            return m["trim"]
        return m["body"]

    join_rings(mesh, rings, color, closed=True, uv_scale=(.7, 17))
    return inner


def flank_graphics(mesh, s, m):
    # Lacquer flashes sweep around both faces. Each end tapers across the beam.
    designs = {
        "classic": ((1.03, 1.64, "trim"), (1.68, 1.74, "foil")),
        "coral": ((1.32, 1.78, "trim"), (1.81, 1.89, "foil"), (1.94, 2.00, "foil")),
        "carbon": ((.90, 1.25, "trim"), (1.29, 1.46, "foil"), (1.50, 1.65, "trim")),
        "gold": ((1.18, 1.59, "foil"), (1.64, 1.71, "trim")),
        "flame": ((1.63, 2.08, "foil"), (2.11, 2.29, "trim")),
    }
    for t0, t1, ink in designs[s.key]:
        for side in (-1, 1):
            for face in (-1, 1):
                pairs = []
                for k, (low, high) in enumerate(((-.48, -.32), (-.45, .32), (.19, .34))):
                    t = side * (t0 + k * .5 * (t1 - t0))
                    row = []
                    for w in (low, high):
                        # Interpolate the actual flat bevel, including its slight pitch.
                        d = .96 + .04 * (w + .52) / .91
                        point = section_point(s, t, w, face * d)
                        point.y += face * .00019
                        row.append(mesh.vertex(point))
                    pairs.append(row)
                for a, b in zip(pairs, pairs[1:]):
                    ids = (a[0], b[0], b[1], a[1])
                    mesh.face(ids if face * side < 0 else ids[::-1], m[ink], smooth=False)


def volcano_fins(mesh, s, m):
    for side in (-1, 1):
        for angle in (.78, 1.02, 1.26, 1.50, 1.74, 1.98):
            # Low swept blade with a ridged spine, two ground bevels and a copper heel.
            rings = []
            for offset, crest, depth in ((-.085, .00035, .0027), (.043, .0042, .0048),
                                         (.072, .00055, .0039)):
                t = side * (angle + offset)
                x, z, nx, nz = head_point(s, t)
                beam = s.beam * (1 - .09 * cos(t))
                ring = []
                for rise, y in ((-.0012, -depth), (.65 * crest, -.82 * depth),
                                (crest, 0), (.65 * crest, .82 * depth), (-.0012, depth)):
                    ring.append(mesh.vertex((x + nx * (beam + rise), y, z + nz * (beam + rise))))
                rings.append(ring)
            join_rings(mesh, rings, lambda i, j: m["foil"] if i == 1 and j in (1, 2)
                       else m["body"], caps=True, reverse=side < 0)


def grip(mesh, s, m):
    offset = pi / 8
    lathe(mesh, [(0, .0184, m["guard"]), (.0012, .0200, m["guard"]),
                 (.004, .0205, m["foil"]), (.0053, .0205, m["guard"]),
                 (.009, .0201, m["grip"]), (.0185, .0181, m["grip"]),
                 (.021, .0175, m["grip"])], 8, offset=offset)
    # A single piece of tape turns around an octagonal pallet. Clipping in
    # unrolled coordinates leaves level ends at both ferrules, even at the seam.
    lo, hi, turns = .017, .1965, 9
    pitch = (hi - lo) / turns
    cache = {}

    def tape_vertex(meridian, z, scale):
        angle = offset + tau * (meridian % 8) / 8
        u = (z - lo) / (hi - lo)
        waist = .0017 if s.key == "carbon" else .00085
        radius = (.0178 - .00135 * u - waist * sin(pi * u)
                  + .00075 * math.exp(-16 * u)) * scale
        key = (meridian % 8, round(z, 9), round(scale, 7))
        if key not in cache:
            cache[key] = mesh.vertex((radius * cos(angle), radius * sin(angle), z))
        return cache[key]

    def clip(poly, height, keep_above):
        result = []
        for a, b in zip(poly, poly[1:] + poly[:1]):
            keep_a = a[1] >= height if keep_above else a[1] <= height
            keep_b = b[1] >= height if keep_above else b[1] <= height
            if keep_a:
                result.append(a)
            if keep_a != keep_b:
                u = (height - a[1]) / (b[1] - a[1])
                result.append(tuple(v + (w - v) * u for v, w in zip(a, b)))
        return result

    # Intersection with a horizontal cut can land between two octagon corners.
    # Interpolate on the flat, rather than rounding the cut into a cylinder.
    cuts = ((0, .949), (.105, .990), (.24, 1.010), (1, .949))
    for i in range(-8, 8 * turns):
        for n, ((f0, r0), (f1, r1)) in enumerate(zip(cuts, cuts[1:])):
            quad = [(i, lo + pitch * (i / 8 + f0), r0),
                    (i + 1, lo + pitch * ((i + 1) / 8 + f0), r0),
                    (i + 1, lo + pitch * ((i + 1) / 8 + f1), r1),
                    (i, lo + pitch * (i / 8 + f1), r1)]
            poly = clip(clip(quad, lo, True), hi, False)
            ids = []
            for meridian, z, scale in poly:
                nearest = round(meridian)
                if abs(meridian - nearest) < 1e-7:
                    idx = tape_vertex(nearest, z, scale)
                else:
                    a = Vector(mesh.vertices[tape_vertex(i, z, scale)])
                    b = Vector(mesh.vertices[tape_vertex(i + 1, z, scale)])
                    idx = mesh.vertex(a.lerp(b, meridian - i))
                if idx not in ids:
                    ids.append(idx)
            if len(ids) >= 3:
                mesh.face(ids, m["groove"] if n == 0 else m["grip"], smooth=False)

    lathe(mesh, [(.195, .0167, m["guard"]), (.1967, .0172, m["guard"]),
                 (.201, .0170, m["foil"]), (.2026, .0170, m["trim"]),
                 (.208, .0152, m["body"]), (.212, .0126, m["body"])], 8, offset=offset)
    # Enamel inset and a little gold tide on the underside, flush with the sole.
    # The octagonal rim is a ring here so the recessed badge remains visible.
    rings = []
    for r, z in ((.0184, 0), (.0145, 0), (.0135, .00042)):
        rings.append([mesh.vertex((r * cos(offset + j * tau / 8),
                                   r * sin(offset + j * tau / 8), z)) for j in range(8)])
    # The original cap's bottom polygon is replaced with the recessed end face.
    bottom_index = next(i for i, face in enumerate(mesh.faces)
                        if len(face) == 8 and all(mesh.vertices[k][2] == 0 for k in face))
    mesh.faces[bottom_index] = tuple(reversed(rings[-1]))
    mesh.face_materials[bottom_index] = mesh.materials.index(m["trim"])
    join_rings(mesh, rings, lambda i, j: m["guard"] if i == 0 else m["foil"], reverse=True)
    for dy in (-.0025, .0020):
        poly = [(-.008, dy), (-.002, dy + .002), (.004, dy), (.008, dy + .001),
                (.008, dy + .0026), (.004, dy + .0016), (-.002, dy + .0036),
                (-.008, dy + .0016)]
        mesh.face([mesh.vertex((x, y, .00036)) for x, y in reversed(poly)],
                  m["foil"], smooth=False)


def throat(mesh, s, m):
    # At the shoulders the spars continue along the lower hoop tangent.
    # The crossbar is a shallow vault with clear space both above and below.
    shoulder = section_point(s, 2.32, 0, 0)
    for side in (-1, 1):
        rail = [(side * x, z, w, d) for x, z, w, d in (
            (.0035, .200, .0083, .0105), (.0068, .223, .0082, .0105),
            (.0148, .250, .0073, .0100), (.0318, .286, .0066, .0094),
            (.0498, .322, .0061, .0090), (.0645, .353, .0061, .0091),
            (.0760, .379, .0065, .0096),
            (shoulder.x, shoulder.z, .0065, s.depth * .91))]

        def rail_mat(i, j):
            if s.key == "classic":
                return m["throat"] if j in (2, 6) else m["body"]
            if s.key == "coral":
                return m["trim"] if i < 6 or j in (2, 6) else m["body"]
            if s.key in ("carbon", "flame") and j in (1, 7) and 1 <= i <= 5:
                return m["trim"]
            if s.key == "gold" and j in (2, 6):
                return m["throat"]
            return m["body"]

        sweep_xz(mesh, rail, LENS, rail_mat)

    bridge_z = {"classic": .325, "coral": .324, "carbon": .315,
                "gold": .328, "flame": .324}[s.key]
    span = .050 + .50 * (bridge_z - .322)
    crown = {"classic": .006, "coral": .009, "carbon": -.006,
             "gold": .009, "flame": -.009}[s.key]
    bridge = [(q * span, bridge_z + crown * (1 - q * q),
               .0027 + .0017 * (1 - abs(q)), .0066 - .0016 * abs(q))
              for q in (-1, -.62, -.28, 0, .28, .62, 1)]
    sweep_xz(mesh, bridge, LENS, m["throat"])
    if s.key == "coral":
        # The second airfoil forks from the first at both ends.
        second = [(x, z - .012 * (1 - (x / span) ** 2), .00165, .0045)
                  for x, z, _, _ in bridge]
        sweep_xz(mesh, second, LENS, m["trim"])
    if s.key == "gold":
        for face in (-1, 1):
            crown_shape = [(-.008, 0), (-.009, .006), (-.004, .003),
                           (0, .008), (.004, .003), (.009, .006), (.008, 0)]
            ids = [mesh.vertex((x, face * .0068, bridge_z + crown + z - .0016))
                   for x, z in crown_shape]
            mesh.face(ids if face > 0 else ids[::-1], m["trim"], smooth=False)


def line_hits(poly, fixed, axis):
    """Intersect a main or cross with the actual polygonal contour."""
    hits = []
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        if min(p[axis], q[axis]) <= fixed < max(p[axis], q[axis]):
            u = (fixed - p[axis]) / (q[axis] - p[axis])
            hits.append((p[1 - axis] + u * (q[1 - axis] - p[1 - axis]), i))
    return sorted(hits)


def printed_wave():
    # A two-stroke tide mark. Ink changes the material of the filament itself.
    shapes = []
    for shift, width in ((.004, .038), (-.008, .030)):
        strip = []
        for i in range(13):
            u = i / 12
            x = (2 * u - 1) * width
            z = .512 + shift + .0069 * sin(tau * u - .7)
            thickness = .0021 + .0018 * sin(pi * u)
            strip.append(((x, z - thickness), (x, z + thickness)))
        shapes.append([lo for lo, hi in strip] + [hi for lo, hi in reversed(strip)])
    return shapes


def stringbed(mesh, s, m, inner):
    ink = printed_wave() if s.key in ("classic", "carbon") else []
    for axis, locations in ((0, [(i - 7.5) * .01415 for i in range(16)]),
                            (1, [.517 + (i - 9) * .01575 for i in range(19)])):
        for fixed in locations:
            (start, ia), (end, ib) = line_hits(inner, fixed, axis)
            color_ranges = []
            for poly in ink:
                hits = line_hits(poly, fixed, axis)
                color_ranges.extend((a[0], b[0]) for a, b in zip(hits[::2], hits[1::2]))
            stops = sorted({start - .00048, end + .00048, *[v for r in color_ranges for v in r]})
            yc = -.00053 if axis == 0 else .00053
            points = [Vector((fixed, yc, p) if axis == 0 else (p, yc, fixed)) for p in stops]

            def dye(i, j):
                mid = .5 * (stops[i] + stops[i + 1])
                return m["trim"] if any(a < mid < b for a, b in color_ranges) else m["strings"]

            tube(mesh, points, .00065, dye, sides=5)
            for value, idx in ((start, ia), (end, ib)):
                x, z = (fixed, value) if axis == 0 else (value, fixed)
                p, q = inner[idx], inner[(idx + 1) % len(inner)]
                tangent = Vector((q[0] - p[0], 0, q[1] - p[1])).normalized()
                out = Vector((-tangent.z, 0, tangent.x))
                center = Vector((x, yc, z)) - .00023 * out
                verts = [mesh.vertex(center + .0020 * cos(a) * tangent + .00175 * sin(a) * Y_AXIS)
                         for a in (0, pi / 2, pi, 3 * pi / 2)]
                # Domed eyelets face inwards and cover the buried ends of both beds.
                nose = mesh.vertex(center - .00060 * out)
                for j in range(4):
                    mesh.face((verts[(j + 1) % 4], nose, verts[j]), m["guard"])
                if z > .568:
                    t0 = tau * idx / HEAD_STEPS
                    fraction = math.hypot(x - p[0], z - p[1]) / math.dist(p, q)
                    t = t0 + fraction * tau / HEAD_STEPS
                    # Oval punched into the bumper floor, flanked by its two raised lips.
                    v = section_point(s, t, .835, 0)
                    ids = [mesh.vertex(v + .0023 * cos(a) * tangent + .00145 * sin(a) * Y_AXIS)
                           for a in (0, pi / 2, pi, 3 * pi / 2)]
                    mesh.face(ids, m["groove"], smooth=False)


def build_racket(s, maps):
    m = racket_finishes(s, maps)
    mesh = Mesh()
    inner = head(mesh, s, m)
    flank_graphics(mesh, s, m)
    if s.key == "flame":
        volcano_fins(mesh, s, m)
    throat(mesh, s, m)
    grip(mesh, s, m)
    stringbed(mesh, s, m, inner)
    return mesh.make(s.title), m["strings"]


# Straight-sided die lettering, with radiused O/C/G/P bowls.
LETTER_O = [(x, y) for x, y in ((.19, 0), (.59, 0), (.72, .10), (.77, .24),
                                (.77, .76), (.72, .90), (.59, 1), (.19, 1),
                                (.06, .90), (.02, .76), (.02, .24), (.06, .10), (.19, 0))]
LETTERS = {
    "A": [[(0, 1), (.37, 0), (.74, 1)], [(.16, .62), (.58, .62)]],
    "C": [[(.72, .13), *LETTER_O[1::-1], *LETTER_O[-2:5:-1], (.72, .87)]],
    "E": [[(.69, 0), (0, 0), (0, 1), (.69, 1)], [(0, .46), (.54, .46)]],
    "G": [[(.72, .13), *LETTER_O[1::-1], *LETTER_O[-2:5:-1], (.74, .82),
           (.74, .55), (.43, .55)]],
    "H": [[(0, 0), (0, 1)], [(.73, 0), (.73, 1)], [(0, .48), (.73, .48)]],
    "I": [[(.37, 0), (.37, 1)]],
    "L": [[(0, 0), (0, 1), (.67, 1)]],
    "M": [[(0, 1), (0, 0), (.37, .60), (.75, 0), (.75, 1)]],
    "N": [[(0, 1), (0, 0), (.74, 1), (.74, 0)]],
    "O": [LETTER_O],
    "P": [[(0, 1), (0, 0), (.51, 0), (.67, .07), (.73, .18), (.72, .37),
           (.62, .48), (.49, .51), (0, .51)]],
}


def plaque_maps(directory):
    w, h = 768, 192
    y, x = np.mgrid[0:h, 0:w]
    distance = np.full((h, w), 1000.0)

    def stroke(points, radius):
        for a, b in zip(points, points[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            u = np.clip(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy), 0, 1)
            d = np.hypot(x - a[0] - u * dx, y - a[1] - u * dy) - radius
            np.minimum(distance, d, out=distance)

    def lettering(word, center, top, size, space):
        widths = [(.45 if c == " " else 1) * space for c in word]
        left = center - (sum(widths[:-1]) + .74 * size) / 2
        for c, advance in zip(word, widths):
            for path in LETTERS.get(c, []):
                stroke([(left + px * size, top + py * size) for px, py in path], size * .059)
            left += advance

    lettering("LAGOON OPEN", 442, 37, 51, 59)
    lettering("CHAMPION", 442, 120, 34, 52)
    stroke([(142, 34), (142, 158)], 1.2)
    stroke([(59 + 30 * cos(a), 87 - 30 * sin(a)) for a in np.linspace(0, pi, 22)], 2.8)
    for dy in (0, 14):
        stroke([(23 + i * 3.7, 104 + dy - 6 * sin(i * tau / 17)) for i in range(20)], 2.4)
    for j in range(5):
        a = (j + .5) * pi / 5
        stroke([(59 + r * cos(a), 87 - r * sin(a)) for r in (37, 44)], 1.7)
    cut = np.clip(.5 - distance / 2, 0, 1)
    bevel = np.clip(1 - np.abs(distance) / 2.2, 0, 1)
    hairline = 2.2 * np.sin(y * 1.79) + 1.0 * np.sin(.18 * x + .71 * y)
    patina = np.array([53, 39, 27])
    metal = np.array([221, 178, 103]) + hairline[..., None]
    albedo = metal * (1 - cut[..., None]) + patina * cut[..., None] + 7 * bevel[..., None]
    depth = -2.1 * np.clip(-distance / 2.3 + .4, 0, 1)
    dy, dx = np.gradient(depth)
    normals = np.stack((-dx, dy, np.ones_like(dx)), axis=2)
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)
    return (packed_png(directory, "Cup plaque - cut brass", albedo),
            packed_png(directory, "Cup plaque - engraving normal", (normals + 1) * 127.5, True))


def rectangular_plinth(mesh, levels):
    rings = []
    for z, w, d, chamfer, _mat in levels:
        ring = ((w - chamfer, -d), (w, -d + chamfer), (w, d - chamfer),
                (w - chamfer, d), (-w + chamfer, d), (-w, d - chamfer),
                (-w, -d + chamfer), (-w + chamfer, -d))
        rings.append([mesh.vertex((x, y, z)) for x, y in ring])
    for i, (a, b) in enumerate(zip(rings, rings[1:])):
        for j in range(8):
            k = (j + 1) % 8
            ids = (a[j], a[k], b[k], b[j])
            # Grain follows the length of each veneered face.
            uv = [(mesh.vertices[v][2] * 11, (mesh.vertices[v][0] + mesh.vertices[v][1]) * 3)
                  for v in ids]
            mesh.face(ids, levels[i][4], uv, smooth=False)
    mesh.face(rings[0][::-1], levels[0][4], smooth=False)
    mesh.face(rings[-1], levels[-1][4], smooth=False)


def disk(mesh, center, normal, radius, levels, sides=32):
    """Beveled face medallion; heights are measured along its outward normal."""
    n = Vector(normal).normalized()
    right = Vector((1, 0, 0))
    up = n.cross(right)
    rings = []
    for r, h, _ in levels:
        rings.append([mesh.vertex(Vector(center) + n * h
                                  + radius * r * (cos(tau * i / sides) * right
                                                   + sin(tau * i / sides) * up))
                      for i in range(sides)])
    join_rings(mesh, rings, lambda i, j: levels[i][2], reverse=True)
    mesh.face(rings[-1], levels[-1][2], smooth=False)
    return right, up, n


def mount_plaque(mesh, m, directory):
    art, normal = plaque_maps(directory)
    engraving = finish("Mat_IntaglioInscription", "D9B16B", metal=.63, rough=.35,
                       image=art, normal_map=normal)
    center_z = .0545
    # Clipped corners, a shadow line and a hand-polished bevel.
    rings = []
    for y, w, h, corner in ((-.0783, .0915, .0236, .0040), (-.0801, .0915, .0236, .0040),
                            (-.0816, .0895, .0218, .0036)):
        xy = ((-w + corner, -h), (w - corner, -h), (w, -h + corner), (w, h - corner),
              (w - corner, h), (-w + corner, h), (-w, h - corner), (-w, -h + corner))
        rings.append([mesh.vertex((x, y, center_z + z)) for x, z in xy])
    join_rings(mesh, rings, lambda i, j: m["patina"] if i == 0 else m["edge"], reverse=True)
    ids = rings[-1]
    uv = [(mesh.vertices[i][0] / .179 + .5, (mesh.vertices[i][2] - center_z) / .0436 + .5)
          for i in ids]
    mesh.face(ids, engraving, uv, smooth=False)
    for x in (-.084, .084):
        for dz in (-.0155, .0155):
            disk(mesh, (x, -.08165, center_z + dz), (0, -1, 0), .00145,
                 [(1, 0, m["edge"]), (.72, .00055, m["patina"])], sides=8)


def bezier_chain(cubics):
    points = []
    for a, b, c, d, steps in cubics:
        for i in range(steps):
            t = i / steps
            u = 1 - t
            points.append(tuple(u**3 * p + 3*u*u*t * q + 3*u*t*t * r + t**3 * s
                                for p, q, r, s in zip(a, b, c, d)))
    points.append(cubics[-1][3])
    return points


def wave_handles(mesh, m):
    spine = bezier_chain([
        ((.068, .255), (.101, .260), (.165, .279), (.187, .327), 7),
        ((.187, .327), (.208, .363), (.216, .417), (.187, .425), 7),
        ((.187, .425), (.159, .434), (.153, .399), (.127, .386), 7)])
    curl = bezier_chain([
        ((.189, .336), (.198, .362), (.188, .390), (.169, .388), 6),
        ((.169, .388), (.156, .387), (.153, .373), (.161, .372), 5)])
    for side in (-1, 1):
        path = []
        for i, (x, z) in enumerate(spine):
            u = i / (len(spine) - 1)
            r = .006 + .0034 * sin(pi * u) ** 2 + .006 * (2 * u - 1)**6
            path.append((side * x, z, r, r * 1.13))
        sweep_xz(mesh, path, LENS, lambda i, j: m["edge"] if j in (2, 6) else m["gold"])
        path = [(side * x, z, .0056 * (1 - .83 * (i / (len(curl)-1))),
                 .0052 * (1 - .82 * (i / (len(curl)-1))))
                for i, (x, z) in enumerate(curl)]
        sweep_xz(mesh, path, round_section(6), m["edge"])


def cup_badge(mesh, m):
    center = Vector((0, -.1235, .348))
    right, up, n = disk(mesh, center, (0, -1, -.24), .0235,
                        [(1, 0, m["patina"]), (1, .0016, m["edge"]),
                         (.93, .0029, m["edge"]), (.825, .0029, m["patina"]),
                         (.78, .0021, m["enamel"])], sides=32)

    def stroke(coords, r):
        path = [center + n * .00265 + right * x + up * y for x, y in coords]
        tube(mesh, path, r, m["edge"], sides=5, reference=n)

    stroke([(.0084 * cos(a), .0024 + .0084 * sin(a)) for a in np.linspace(0, pi, 14)], .00082)
    for dy in (-.0023, -.0065):
        stroke([(-.0135 + .00225 * i, dy + .0018 * sin(i * tau / 11))
                for i in range(13)], .00078)
    for j in range(5):
        a = (j + .5) * pi / 5
        stroke([(r * cos(a), .0024 + r * sin(a)) for r in (.0110, .0135)], .00062)


def laurel(mesh, m):
    lathe(mesh, [(.447, .017, m["patina"]), (.453, .024, m["gold"]),
                 (.457, .032, m["edge"]), (.460, .034, m["gold"]),
                 (.464, .032, m["enamel"]), (.467, .031, m["edge"]),
                 (.471, .027, m["gold"]), (.481, .018, m["gold"])], 32)
    for j in range(18):
        a = tau * j / 18
        radial = Vector((cos(a), sin(a), 0))
        along = Vector((-sin(a), cos(a), 0))
        root = radial * .030 + Z_AXIS * .463

        def point(u, width, ridge=0):
            return mesh.vertex(root + along * (.018 * u + width)
                               + radial * (.004 * sin(pi * u) + .006 * u + ridge)
                               + Z_AXIS * (.023 * u - .55 * width))

        base, tip = point(0, 0), point(1, 0)
        l, r, vein = point(.47, -.0058), point(.55, .0058), point(.56, 0, .0025)
        for ids, mat in (((base, r, vein), m["edge"]), ((r, tip, vein), m["edge"]),
                         ((tip, l, vein), m["gold"]), ((l, base, vein), m["gold"]),
                         ((base, l, tip, r), m["patina"])):
            mesh.face(ids, mat, smooth=False)


def tennis_finial(mesh, m):
    # A single continuous tennis seam separates two spherical panels. Turning
    # its polar axis towards the gallery reveals both horseshoes from the front.
    sides, radius = 40, .042
    rows = [[] for _ in range(13)]
    for j in range(sides):
        theta = tau * j / sides
        seam = .91 * cos(2 * theta - .64)
        low, high = seam - .044, seam + .044
        latitudes = [(-pi / 2) * (1-u) + low * u for u in (.18, .39, .61, .82, 1)]
        latitudes += [seam - .022, seam, seam + .022]
        latitudes += [high * (1-u) + pi / 2 * u for u in (0, .18, .39, .61, .82)]
        for i, a in enumerate(latitudes):
            r = radius - ({5: .00065, 6: .00088, 7: .00065}.get(i, 0))
            rows[i].append(mesh.vertex((r * cos(a) * cos(theta), -r * sin(a),
                                        .518 + r * cos(a) * sin(theta))))
    def panel(i, j):
        return m["seam"] if 4 <= i <= 7 else m["ball"]

    join_rings(mesh, rows, panel, reverse=True)
    for row, y, reverse in ((rows[0], radius, True), (rows[-1], -radius, False)):
        pole = mesh.vertex((0, y, .518))
        for j in range(sides):
            ids = (pole, row[j], row[(j + 1) % sides])
            mesh.face(ids[::-1] if reverse else ids, m["ball"])


def build_trophy(maps, directory):
    m = dict(gold=finish("Mat_Cup_SpunGold", "D7A451", .87, .25, .20,
                         rough_map=maps["brush"]),
             edge=finish("Mat_Cup_BurnishedEdges", "F2C779", .84, .20, .27),
             patina=finish("Mat_Cup_AntiqueBrass", "8E5D32", .77, .32),
             enamel=finish("Mat_Cup_PetrolEnamel", "124744", .29, .24, .52),
             wood=finish("Mat_PolishedMahogany", "79452F", .06, .30, .48,
                         image=maps["mahogany"]),
             ball=finish("Mat_Finial_HoneyGold", "E7AF48", .76, .28, .18),
             seam=finish("Mat_Finial_Seam", "FFF0C5", .58, .29))
    g, e, p, w, enamel = (m[k] for k in ("gold", "edge", "patina", "wood", "enamel"))
    mesh = Mesh()
    rectangular_plinth(mesh, [
        (0, .123, .086, .012, p), (.002, .128, .091, .012, e),
        (.006, .128, .091, .012, w), (.009, .129, .0915, .012, w),
        (.016, .129, .0915, .012, e), (.0183, .127, .0895, .011, w),
        (.022, .120, .083, .011, w), (.027, .113, .0785, .009, w),
        (.085, .113, .0785, .009, e), (.088, .117, .082, .009, p),
        (.091, .121, .085, .009, w), (.099, .121, .085, .009, e),
        (.102, .119, .083, .008, w), (.106, .110, .074, .008, w)])
    mount_plaque(mesh, m, directory)
    lathe(mesh, [(.106, .064, p), (.108, .070, e), (.112, .070, p),
                 (.115, .066, g), (.119, .064, g), (.124, .051, g),
                 (.133, .038, e), (.139, .034, enamel), (.145, .034, e),
                 (.148, .031, g), (.154, .024, g), (.170, .019, g),
                 (.183, .020, e), (.189, .026, p), (.193, .028, e),
                 (.197, .027, g), (.204, .021, g), (.211, .023, g)], 28)
    lathe(mesh, [(.202, .020, p, .001), (.211, .026, g, .0035),
                 (.224, .043, g, .0053), (.252, .067, g, .0059),
                 (.284, .090, g, .0057), (.320, .110, g, .0046),
                 (.346, .121, g, .0023), (.361, .125, g, .0006),
                 (.370, .127, g, 0), (.383, .129, e, 0),
                 (.388, .132, e, 0)], 64, flutes=16)
    lathe(mesh, [(.378, .128, p), (.380, .131, e), (.382, .132, enamel),
                 (.387, .132, e), (.390, .136, g), (.395, .136, e),
                 (.398, .132, p), (.400, .128, g), (.404, .125, g),
                 (.413, .109, g), (.425, .081, g), (.434, .052, e),
                 (.437, .046, g), (.441, .036, g), (.448, .018, g)], 36)
    wave_handles(mesh, m)
    cup_badge(mesh, m)
    laurel(mesh, m)
    tennis_finial(mesh, m)
    return mesh.make("Lagoon Open Championship Cup")


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def export_glb(obj, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
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
    mats = [m.get("name") for m in meta.get("materials", [])]
    print(f"[GLB] {path.name}: {len(data)/1024:.1f} KB | mats={len(mats)}")
    return meta


def setup_cycles(res=(1280, 760), samples=28):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 8
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("RacketStudio")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.55, 0.72, 0.78, 1.0)
    bg.inputs["Strength"].default_value = 0.85

    def add_light(name, kind, loc, rot, energy, col=(1, 1, 1), size=2.0):
        ld = bpy.data.lights.new(name, type=kind)
        ld.energy = energy
        ld.color = col
        if kind == "AREA":
            ld.size = size
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = rot

    add_light("Key", "AREA", (1.6, -2.0, 2.2), (math.radians(52), 0, math.radians(38)), 160, (1.0, 0.96, 0.88), 2.2)
    add_light("Fill", "AREA", (-2.0, -1.6, 1.4), (math.radians(66), 0, math.radians(-50)), 95, (0.76, 0.92, 1.0), 2.5)
    add_light("Rim", "AREA", (0.2, 2.2, 1.8), (math.radians(-62), 0, math.radians(175)), 150, (1.0, 0.92, 0.78), 2.2)

    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.data.materials.append(finish("StudioSurface", "EAE2D2", metal=0.0, rough=0.68))


def add_camera(loc, target, lens=55):
    cd = bpy.data.cameras.new("Cam")
    cd.lens = lens
    co = bpy.data.objects.new("Cam", cd)
    bpy.context.scene.collection.objects.link(co)
    co.location = Vector(loc)
    co.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = co
    return co


def main():
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)

        # 1. Export all 5 rackets cleanly in isolated scenes
        for spec in RACKETS:
            clear_scene()
            maps = surface_maps(tmp)
            obj, _ = build_racket(spec, maps)
            export_glb(obj, MODELS / "rackets" / f"racket_{spec.key}.glb")

        # 2. Export Lagoon Open Championship Cup cleanly
        clear_scene()
        maps = surface_maps(tmp)
        trophy = build_trophy(maps, tmp)
        export_glb(trophy, MODELS / "props" / "lagoon_trophy.glb")

        # 3. Render Trophy Cycles CPU preview
        setup_cycles((900, 1080), samples=32)
        add_camera((0.42, -1.02, 0.42), (0.0, 0.0, 0.28), lens=55)
        bpy.context.scene.render.filepath = str(PREVIEWS / "trophy_preview.png")
        bpy.ops.render.render(write_still=True)

        # 4. Render 5-Racket Lineup Cycles CPU preview
        clear_scene()
        maps = surface_maps(tmp)
        for i, spec in enumerate(RACKETS):
            obj, _ = build_racket(spec, maps)
            obj.location = ((i - 2) * 0.30, 0, 0)
            obj.rotation_euler = (math.radians(-6), 0, math.radians(-18))
        setup_cycles((1440, 820), samples=24)
        add_camera((0.0, -2.05, 0.44), (0.0, 0.0, 0.34), lens=48)
        bpy.context.scene.render.filepath = str(PREVIEWS / "rackets_lineup.png")
        bpy.ops.render.render(write_still=True)

    print("[OK] All 5 rackets and championship trophy exported and rendered cleanly.")


if __name__ == "__main__":
    main()
