"""
Hug lock: a no-tools, no-adhesive child lock for interior doors.

A U-shaped clip slides over the latch-side edge of the door, high up. On the
door-stop side, a turn swings a paddle over the back of the door stop, so the
door can no longer swing open. Turn it back and the door opens as normal.

Coordinates (looking at the door from the door-stop side, i.e. the side the
door does NOT open towards):
  x  across the door face, 0 at the door edge, +x into the door
  y  up
  z  out of the door face towards you, 0 on the door face

Measure your door and change the values in PARAMS, then run:
    python3 hug_lock.py            # writes the STLs and a preview PNG
"""
import math
import os
import sys

import cadquery as cq

PARAMS = dict(
    door_thickness=35.0,   # UK internal doors are usually 35 mm (some 40 or 44)
    stop_thickness=12.0,   # how far the door stop stands proud of the closed door
    stop_overlap=22.0,     # how far the stop reaches over the door face from its edge
    clip_height=36.0,      # height of the clip along the door edge
    bridge=1.6,            # part that sits in the gap between door edge and frame
    leg=1.6,               # stop-side leg, pinched between door and stop
    back_leg=2.4,          # leg on the opening side of the door
    back_leg_length=30.0,
    grip=0.6,              # how much the back leg pinches the door
    paddle_width=12.0,
    paddle_thickness=4.0,
    paddle_tip=3.0,        # paddle tip stops this far short of the door edge
    clearance=0.8,         # paddle sits this far above the door stop
    tol=0.3,               # general print clearance
)

OUT = os.path.dirname(os.path.abspath(__file__))

# Fixed detail sizes
TURRET_W = 22.0       # turret footprint along x
HUB_D = 20.0
HUB_T = 5.0
HEX_AF = 6.0          # pin hex across flats
PIN_HOLE_D = 7.4      # round hole in the turret the hex pin turns in
HEAD_D = 10.0
HEAD_T = 2.5
LIP_D = 8.4           # snap lip diameter
LIP_T = 1.8
UNDERCUT_D = 9.8      # pocket under the turret the lips snap into
UNDERCUT_T = 3.0
PEG_D = 3.0
PEG_R = 7.0           # radius of the travel-stop peg and groove
UNLOCKED_DEG = 80.0   # paddle angle (from +x, anticlockwise) when unlocked: up, leaning off the stop
LOCKED_DEG = 180.0    # paddle angle when locked: flat, reaching over the stop


def derived(p):
    d = dict(p)
    d["turret_x0"] = p["stop_overlap"] + 1.5
    d["axis_x"] = d["turret_x0"] + TURRET_W / 2
    d["turret_h"] = p["stop_thickness"] + p["clearance"]
    d["paddle_len"] = d["axis_x"] - p["paddle_tip"]
    return d


def body(p):
    d = derived(p)
    T, H = p["door_thickness"], p["clip_height"]
    b, l, bl = p["bridge"], p["leg"], p["back_leg"]

    # U-profile in the x-z plane, extruded up the door edge (y)
    pts = [
        (-b, -T - bl),
        (p["back_leg_length"], -T - bl),
        (p["back_leg_length"], -T),
        (0, -T),
        (0, 0),
        (d["turret_x0"] + TURRET_W, 0),
        (d["turret_x0"] + TURRET_W, l),
        (-b, l),
    ]
    prof = cq.Workplane("XZ").polyline(pts).close().extrude(-H)
    # round the inside corners at the door edge (doors have rounded arrises)
    prof = prof.edges("|Y").edges(cq.selectors.NearestToPointSelector((0, H / 2, 0))).fillet(1.0)
    prof = prof.edges("|Y").edges(cq.selectors.NearestToPointSelector((0, H / 2, -T))).fillet(1.0)

    # grip bump on the back leg tip
    bump = (
        cq.Workplane("XZ")
        .center(p["back_leg_length"] - 4, -T)
        .circle(p["grip"] + 1.5)
        .extrude(-H)
        .intersect(
            cq.Workplane("XY")
            .box(20, H, p["grip"], centered=(True, False, False))
            .translate((p["back_leg_length"] - 4, 0, -T))
        )
    )

    turret = (
        cq.Workplane("XY")
        .box(TURRET_W, H, d["turret_h"], centered=False)
        .translate((d["turret_x0"], 0, 0))
    )
    turret = turret.edges("|Y and >Z").fillet(2.0)

    body = prof.union(turret).union(bump)

    ax, ay = d["axis_x"], H / 2
    hole = cq.Workplane("XY").center(ax, ay).circle(PIN_HOLE_D / 2).extrude(d["turret_h"] + 1).translate((0, 0, -0.5))
    pocket = cq.Workplane("XY").center(ax, ay).circle(UNDERCUT_D / 2).extrude(UNDERCUT_T + 0.5).translate((0, 0, -0.5))
    body = body.cut(hole).cut(pocket)

    # travel-stop peg on the turret top, pointing into the door (+x)
    peg = (
        cq.Workplane("XY")
        .center(ax + PEG_R, ay)
        .circle(PEG_D / 2)
        .extrude(1.6)
        .translate((0, 0, d["turret_h"]))
    )
    body = body.union(peg)
    return body


def turn(p, hand="left"):
    """Paddle + hub + finger grip, modelled at the origin with the paddle along +x."""
    d = derived(p)
    w, t = p["paddle_width"], p["paddle_thickness"]
    L = d["paddle_len"]

    hub = cq.Workplane("XY").circle(HUB_D / 2).extrude(HUB_T)
    paddle = (
        cq.Workplane("XY")
        .center(L / 2, 0)
        .rect(L, w)
        .extrude(t)
        .edges("|Z and >X")
        .fillet(w / 2 - 0.01)
    )
    fin_len = min(26.0, L - 2)
    fin = (
        cq.Workplane("XZ")
        .polyline([(6.5, 0), (6.5 + fin_len, 0), (6.5 + fin_len, t + 4), (6.5 + fin_len - 6, 16), (8.5, 16), (6.5, 12)])
        .close()
        .extrude(3, both=True)
    )
    part = hub.union(paddle).union(fin)

    # hex socket for the pin, and counterbore for its head
    hexsock = cq.Workplane("XY").polygon(6, (HEX_AF + p["tol"]) / math.cos(math.pi / 6)).extrude(HUB_T + 1).translate((0, 0, -0.5))
    head = cq.Workplane("XY").circle((HEAD_D + 0.8) / 2).extrude(HEAD_T + 0.5).translate((0, 0, HUB_T - HEAD_T))
    part = part.cut(hexsock).cut(head)

    # travel-stop groove on the hub underside. The peg sits at world angle 0,
    # so in hub coordinates it sits at (0 - paddle angle).
    half = math.degrees(math.asin((PEG_D / 2 + p["tol"]) / PEG_R))
    a0 = -LOCKED_DEG - half
    a1 = -UNLOCKED_DEG + half
    sweep = a1 - a0
    groove = (
        cq.Workplane("XY")
        .transformed(rotate=(0, 0, a0))
        .moveTo(PEG_R - (PEG_D / 2 + p["tol"]), 0)
        .lineTo(PEG_R + (PEG_D / 2 + p["tol"]), 0)
        .threePointArc(
            (
                (PEG_R + PEG_D / 2 + p["tol"]) * math.cos(math.radians(sweep / 2)),
                (PEG_R + PEG_D / 2 + p["tol"]) * math.sin(math.radians(sweep / 2)),
            ),
            (
                (PEG_R + PEG_D / 2 + p["tol"]) * math.cos(math.radians(sweep)),
                (PEG_R + PEG_D / 2 + p["tol"]) * math.sin(math.radians(sweep)),
            ),
        )
        .lineTo(
            (PEG_R - PEG_D / 2 - p["tol"]) * math.cos(math.radians(sweep)),
            (PEG_R - PEG_D / 2 - p["tol"]) * math.sin(math.radians(sweep)),
        )
        .threePointArc(
            (
                (PEG_R - PEG_D / 2 - p["tol"]) * math.cos(math.radians(sweep / 2)),
                (PEG_R - PEG_D / 2 - p["tol"]) * math.sin(math.radians(sweep / 2)),
            ),
            (PEG_R - PEG_D / 2 - p["tol"], 0),
        )
        .close()
        .extrude(2.0 + 0.5)
        .translate((0, 0, -0.5))
    )
    part = part.cut(groove)
    if hand == "right":
        part = part.mirror("XZ")
    return part


def pin(p):
    """Hex pin, along +z with the head at the top. Snaps under the turret."""
    d = derived(p)
    head_z = d["turret_h"] + HUB_T - HEAD_T          # underside of the head, in body coords
    lip_top = UNDERCUT_T - 0.3                       # a little axial play
    z0 = lip_top - LIP_T
    shaft = cq.Workplane("XY").polygon(6, HEX_AF / math.cos(math.pi / 6)).extrude(head_z - z0).translate((0, 0, z0))
    head = cq.Workplane("XY").circle(HEAD_D / 2).extrude(HEAD_T).translate((0, 0, head_z))
    lip = (
        cq.Workplane("XY").circle(HEX_AF / 2 + 0.2).workplane(offset=LIP_T * 0.6).circle(LIP_D / 2).loft()
        .union(cq.Workplane("XY").circle(LIP_D / 2).extrude(LIP_T * 0.4).translate((0, 0, LIP_T * 0.6)))
        .translate((0, 0, z0))
    )
    # keep the lip within the hex flats (y) so the pin lies flat on its side to print
    lip = lip.intersect(cq.Workplane("XY").box(20, HEX_AF, 20).translate((0, 0, z0 + 5)))
    part = shaft.union(head).union(lip)
    slot = cq.Workplane("XY").box(1.6, 20, 9.0, centered=(True, True, False)).translate((0, 0, z0 - 0.01))
    return part.cut(slot)


def placed_turn(p, angle_deg, hand="left"):
    d = derived(p)
    t = turn(p, hand)
    if hand == "right":
        angle_deg = -angle_deg
    t = t.rotate((0, 0, 0), (0, 0, 1), angle_deg)
    return t.translate((d["axis_x"], p["clip_height"] / 2, d["turret_h"]))


def placed_pin(p):
    d = derived(p)
    return pin(p).translate((d["axis_x"], p["clip_height"] / 2, 0))


def check(p):
    """Interference and engagement checks in both positions."""
    d = derived(p)
    b = body(p)
    ok = True
    for name, ang in (("unlocked", UNLOCKED_DEG), ("locked", LOCKED_DEG)):
        clash = b.intersect(placed_turn(p, ang)).val().Volume()
        print(f"  turn vs body ({name}): {clash:.3f} mm^3 overlap")
        ok &= clash < 0.01
    # just past each end stop should clash (the stop actually stops it)
    for name, ang in (("past unlocked", UNLOCKED_DEG - 6), ("past locked", LOCKED_DEG + 6)):
        clash = b.intersect(placed_turn(p, ang)).val().Volume()
        print(f"  turn vs body ({name}): {clash:.3f} mm^3 overlap (should be > 0)")
        ok &= clash > 0.01
    pclash = b.intersect(placed_pin(p)).val().Volume()
    print(f"  pin vs body (lips compressed in reality): {pclash:.3f} mm^3")
    tclash = placed_turn(p, LOCKED_DEG).intersect(placed_pin(p)).val().Volume()
    print(f"  pin vs turn: {tclash:.3f} mm^3")
    ok &= tclash < 0.01
    # the door stop, as a block, must not hit the clip but must sit under the locked paddle
    stop = cq.Workplane("XY").box(p["stop_overlap"] + 40, 200, p["stop_thickness"], centered=False).translate((-40, -100, p["leg"]))
    sclash = b.intersect(stop).val().Volume()
    print(f"  door stop vs clip: {sclash:.3f} mm^3")
    ok &= sclash < 0.01
    lock_shadow = placed_turn(p, LOCKED_DEG).intersect(stop.translate((0, 0, p["clearance"] + 0.5))).val().Volume()
    unl_shadow = placed_turn(p, UNLOCKED_DEG).intersect(stop.translate((0, 0, p["clearance"] + 0.5))).val().Volume()
    print(f"  paddle over stop: locked {lock_shadow:.1f} mm^3 (want > 0), unlocked {unl_shadow:.1f} (want 0)")
    ok &= lock_shadow > 1 and unl_shadow < 0.01
    print("CHECKS PASSED" if ok else "CHECKS FAILED")
    return ok


def export(p):
    b = body(p)
    # print the body on its side, U-profile flat on the bed
    cq.exporters.export(b.rotate((0, 0, 0), (1, 0, 0), 90), os.path.join(OUT, "hug_lock_body.stl"))
    cq.exporters.export(turn(p, "left"), os.path.join(OUT, "hug_lock_turn_left.stl"))
    cq.exporters.export(turn(p, "right"), os.path.join(OUT, "hug_lock_turn_right.stl"))
    # pin lies on a hex flat
    cq.exporters.export(pin(p).rotate((0, 0, 0), (1, 0, 0), 90), os.path.join(OUT, "hug_lock_pin.stl"))


if __name__ == "__main__":
    check(PARAMS) or sys.exit(1)
    export(PARAMS)
    print("wrote STLs to", OUT)
