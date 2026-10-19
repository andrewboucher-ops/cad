"""Render preview.png: front views (unlocked / locked) and a top-down view of the lock on a door."""
import matplotlib

matplotlib.use("Agg")
import cadquery as cq
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection

import hug_lock as hl

p = hl.PARAMS
d = hl.derived(p)
T, H = p["door_thickness"], p["clip_height"]
GAP = 3.0  # gap between door edge and frame, for the picture only


def project(wp, axes):
    """Triangles projected onto two of x/y/z, with mean depth on the third for sorting."""
    verts, faces = wp.val().tessellate(0.1, 0.2)
    v = [(q.x, q.y, q.z) for q in verts]
    i, j, k = axes
    out = []
    for f in faces:
        tri = [v[n] for n in f]
        out.append(([(t[i], t[j]) for t in tri], sum(t[k] for t in tri) / 3))
    return out


def scene(angle):
    return [
        (cq.Workplane("XY").box(90, 160, T, centered=False).translate((0, -60, -T)), "#eadfc8"),
        (cq.Workplane("XY").box(30, 160, 60, centered=False).translate((-30 - GAP, -60, -T - 10)), "#d4c3a0"),
        (cq.Workplane("XY").box(p["stop_overlap"] + GAP, 160, p["stop_thickness"], centered=False).translate((-GAP, -60, p["leg"])), "#b89b6a"),
        (hl.body(p), "#3b82c4"),
        (hl.placed_turn(p, angle), "#e8762c"),
        (hl.placed_pin(p), "#444444"),
    ]


def draw(ax, angle, axes, title, depth_sign, xlim, ylim, labels):
    polys, colors, depth = [], [], []
    for wp, c in scene(angle):
        for tri, z in project(wp, axes):
            polys.append(tri)
            colors.append(c)
            depth.append(z * depth_sign)
    order = sorted(range(len(polys)), key=lambda n: depth[n])
    ax.add_collection(PolyCollection([polys[n] for n in order], facecolors=[colors[n] for n in order], edgecolors=[colors[n] for n in order], linewidths=0.2))
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.set_aspect("equal")
    ax.set_title(title, fontsize=11)
    ax.set_xticks([])
    ax.set_yticks([])
    for x, y, s in labels:
        ax.text(x, y, s, fontsize=8, ha="center", va="center")


fig, axs = plt.subplots(1, 3, figsize=(15, 6), dpi=110)
front = dict(axes=(0, 1, 2), depth_sign=1, xlim=(-36, 75), ylim=(-30, 85))
draw(axs[0], hl.UNLOCKED_DEG, title="Unlocked (seen from the door-stop side)",
     labels=[(-18, 75, "frame"), (10, 75, "door\nstop"), (55, 75, "door")], **front)
draw(axs[1], hl.LOCKED_DEG, title="Locked: paddle lies over the stop",
     labels=[(-18, 75, "frame"), (10, 75, "door\nstop"), (55, 75, "door")], **front)
draw(axs[2], hl.LOCKED_DEG, axes=(0, 2, 1), depth_sign=1, xlim=(-36, 75), ylim=(-48, 40),
     title="Top view, locked: door can't swing\nto the bottom of the picture",
     labels=[(-20, 30, "frame"), (55, -18, "door"), (8, 6, "stop"), (40, 34, "door-stop side")])
fig.text(0.5, 0.03, "blue: clip   orange: turn   grey: pin   tan: door, frame and door stop", ha="center")
plt.tight_layout(rect=(0, 0.05, 1, 1))
plt.savefig("preview.png")
