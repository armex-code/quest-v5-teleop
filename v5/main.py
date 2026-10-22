# V5 brain program — Quest teleop target (VEXcode V5 Python, deploy from VEXcode).
#
# Based on the user's proven khatt-bot program (khatt-bot-main/graphical_replica/
# src/main.py): same IK, same motor config, same gear ratio, same workspace
# mapping. Two additions for the digital twin:
#   1. Telemetry: prints "E,q1,q2,c1,c2\n" over USB serial at 20 Hz
#      (q = measured arm-frame angles from encoders, c = last commanded), which
#      server/run.py forwards to the Quest.
#   2. Gripper end effector: the third field of each frame closes (1) or opens
#      (0) a smart-motor gripper. Torque-limited while closing, and it backs
#      off to a lower holding torque once stalled against the object.
#
# Serial input (from server/run.py), one line per frame at <= 25 Hz:
#   "<x_norm>,<y_norm>,<grip>\n"   e.g. "0.512300,0.480010,1"
from vex import *
import math
import random
import sys

brain = Brain()

kill_switch = Bumper(brain.three_wire_port.a)
reset_switch = Bumper(brain.three_wire_port.b)

# Ports confirmed against the real robot 2026-10-22: shoulder PORT11, elbow
# PORT20, gripper PORT12. Shoulder and gripper were initially recorded the
# other way round and corrected the same day — both run 36:1 cartridges, so
# the swap was ports only and the gearing did not move with it.
# These supersede the PORT1 / PORT4 in the inherited khatt-bot program, which
# predates the current wiring.
shoulder_motor = Motor(Ports.PORT11, GearSetting.RATIO_36_1, True)
elbow_motor = Motor(Ports.PORT20, GearSetting.RATIO_18_1, False)

GEAR_RATIO = 84 / 12  # external gear ratio = 7
L_SHOULDER = 20.5
L_ELBOW = 30.5

# Joint limits, read off the brain 2026-10-22: +-900 MOTOR degrees on each
# joint, so +-900/7 = +-128.6 at the joint itself. Zero is the fully extended
# startup pose, because reset_position() runs below -- which is why the arm
# must be started straight out along the depth axis.
#
# These matter: the Jacobian solver below is pure geometry and knows nothing
# about stops, so without this check it will happily converge on a pose the
# arm cannot physically reach (the near edge of the old workspace needed
# ~151 deg of elbow) and the P-loop then drives the motor into its hard stop.
JOINT_LIMIT_DEG = 900.0 / GEAR_RATIO

# ── Gripper end effector ─────────────────────────────────────────────────────
# Travel measured on the real gripper (2026-10-22): fully open is the startup
# pose, fully closed is -237 motor degrees from it. The encoder is zeroed at
# startup (reset_position below), so only that *difference* is meaningful —
# always start the program with the jaws OPEN.
# Closing direction lives in the SIGN of GRIP_CLOSED_DEG. Leave GRIP_REVERSED
# alone unless the motor is physically mounted mirrored; flipping both just
# cancels out and the jaws drive the wrong way again.
GRIP_PORT = Ports.PORT12       # corrected 2026-10-22 (was swapped with shoulder)
GRIP_GEARING = GearSetting.RATIO_36_1   # 36:1 cartridge
GRIP_REVERSED = False
GRIP_OPEN_DEG = 0              # = the startup pose
GRIP_CLOSED_DEG = -237         # motor degrees at fully closed on nothing
GRIP_VELOCITY_PCT = 60         # 36:1 is 100 rpm free -> full close in ~0.7 s
# Squeeze torque is halved relative to an 18:1 build: the 36:1 cartridge gives
# roughly double the output torque for the same percentage. Deliberately gentle
# for the first run — a weak grip drops the object (recoverable), an overstrong
# one strips the gripper (not). Raise GRIP_TORQUE_PCT if objects slip.
GRIP_TORQUE_PCT = 20           # squeeze torque while closing
GRIP_HOLD_TORQUE_PCT = 8       # reduced torque once stalled on the object
GRIP_STALL_TICKS = 15          # 20 ms ticks of ~no motion before "stalled"

gripper_motor = Motor(GRIP_PORT, GRIP_GEARING, GRIP_REVERSED)

shoulder_motor.reset_position()
elbow_motor.reset_position()
gripper_motor.reset_position()
gripper_motor.set_velocity(GRIP_VELOCITY_PCT, PERCENT)
gripper_motor.set_max_torque(GRIP_TORQUE_PCT, PERCENT)
gripper_motor.set_stopping(HOLD)

stop_requested = False
reset_requested = False

def watch_kill_switch():
    global stop_requested
    while True:
        if kill_switch.pressing():
            stop_requested = True
            shoulder_motor.stop(BRAKE)
            elbow_motor.stop(BRAKE)
            # HOLD, not COAST: killing the arm shouldn't drop a held object.
            gripper_motor.stop(HOLD)
            brain.program_stop()
        wait(20, MSEC)

Thread(watch_kill_switch)

def watch_reset_switch():
    global reset_requested

    while True:
        if reset_switch.pressing():
            reset_requested = True

            global_angles["theta1"] = 0
            global_angles["theta2"] = 0
            target_angles["theta1"] = 0.0
            target_angles["theta2"] = 0.0
            wait(2000, MSEC)

            brain.program_stop()

Thread(watch_reset_switch)


# Global state: persists across multiple go_to calls (absolute angles, degrees)
global_angles = {"theta1": 0, "theta2": 0}

def calculate_inverse_jacobian_pure(x_target, y_target,
                                     theta1_init=None, theta2_init=None,
                                     max_iterations=1000, tolerance=1e-4, num_restarts=10):

    def attempt(theta1, theta2):
        for _ in range(max_iterations):
            x_current = L_SHOULDER * math.cos(theta1) + L_ELBOW * math.cos(theta1 + theta2)
            y_current = L_SHOULDER * math.sin(theta1) + L_ELBOW * math.sin(theta1 + theta2)

            error_x = x_target - x_current
            error_y = y_target - y_current
            error_distance = math.sqrt(error_x**2 + error_y**2)

            if error_distance < tolerance:
                return theta1, theta2, True

            j11 = -L_SHOULDER * math.sin(theta1) - L_ELBOW * math.sin(theta1 + theta2)
            j12 = -L_ELBOW * math.sin(theta1 + theta2)
            j21 = L_SHOULDER * math.cos(theta1) + L_ELBOW * math.cos(theta1 + theta2)
            j22 = L_ELBOW * math.cos(theta1 + theta2)

            det = j11 * j22 - j12 * j21
            if abs(det) < 1e-6:
                break

            inv_j11 =  j22 / det
            inv_j12 = -j12 / det
            inv_j21 = -j21 / det
            inv_j22 =  j11 / det

            delta_theta1 = inv_j11 * error_x + inv_j12 * error_y
            delta_theta2 = inv_j21 * error_x + inv_j22 * error_y

            max_step = 0.5
            scale = min(1.0, max_step / (abs(delta_theta1) + abs(delta_theta2) + 1e-9))
            theta1 += scale * delta_theta1
            theta2 += scale * delta_theta2

        return theta1, theta2, False

    def wrap_deg(rad):
        # The solver can walk past +-180; fold it back so the limit test is
        # about the pose, not the number of turns taken to describe it.
        d = math.degrees(rad)
        return (d + 180.0) % 360.0 - 180.0

    def usable(t1, t2):
        """Converged AND inside the joint stops. Both, or it is no solution."""
        return (abs(wrap_deg(t1)) <= JOINT_LIMIT_DEG and
                abs(wrap_deg(t2)) <= JOINT_LIMIT_DEG)

    init_t1 = theta1_init if theta1_init is not None else math.atan2(y_target, x_target)
    init_t2 = theta2_init if theta2_init is not None else 0.1

    best = attempt(init_t1, init_t2)
    if best[2] and usable(best[0], best[1]):
        return wrap_deg(best[0]), wrap_deg(best[1])

    # Restarts also serve to find the OTHER elbow branch: a point can be
    # reachable elbow-up and out of range elbow-down, and the first attempt
    # seeds from the current pose so it tends to stay on one branch.
    for _ in range(num_restarts):
        t1 = random.uniform(-math.pi, math.pi)
        t2 = random.uniform(-math.pi, math.pi)
        result = attempt(t1, t2)
        if result[2] and usable(result[0], result[1]):
            return wrap_deg(result[0]), wrap_deg(result[1])

    brain.screen.clear_screen()
    brain.screen.set_cursor(1, 1)
    brain.screen.print("IK did not converge for target(", x_target, ",", y_target, ")")
    return None  # signal failure clearly instead of silently returning (0,0)

def normalized_to_workspace(x_norm, y_norm):
    # 48 cm wide x 15 cm deep, fitted to the arm's REAL reach 2026-10-22.
    #
    # Derived from the measured joint limits (+-128.6 deg each) rather than
    # from link lengths alone, because the elbow limit is what binds:
    #   |q2| <= 128.6  =>  the arm cannot fold tighter than r = 23.9 cm,
    #   so the inner boundary is 23.9, NOT the 10.0 that L2-L1 suggests.
    # Both earlier workspaces ignored that and put their near edge at depth
    # 16-18, i.e. inside the hole -- the solver would "reach" those points
    # with ~151 deg of elbow and drive the motor into its stop.
    #
    # A square is a bad shape in this ring (the hole eats the near edge while
    # full extension caps the far one): the biggest square is 20x20 = 400
    # cm2, versus 744 cm2 for this rectangle. Wider also suits pick-and-place.
    X_MIN, X_MAX = -24.0, 24.0   # lateral
    Y_MIN, Y_MAX = 26.0, 41.0    # depth
    x_norm = max(0.0, min(1.0, x_norm))
    y_norm = max(0.0, min(1.0, y_norm))

    x = X_MIN + y_norm * (X_MAX - X_MIN)
    y = Y_MIN + x_norm * (Y_MAX - Y_MIN)

    return x, y

target_angles = {"theta1": 0.0, "theta2": 0.0}
grip_closed = False

# Toned down from the original 70/8/0.3 for teleop: hand tracking is noisier
# than a mouse, so favor smoothness over speed.
MAX_VELOCITY = 40
MIN_VELOCITY = 5
DEADBAND_DEG = 3.0
KP = 0.25

def go_to(x, y):
    global global_angles

    wx, wy = normalized_to_workspace(x, y)

    result = calculate_inverse_jacobian_pure(
        wy, wx,
        theta1_init=math.radians(global_angles["theta1"]),
        theta2_init=math.radians(global_angles["theta2"])
    )

    if result is None:
        return

    t1, t2 = result

    global_angles["theta1"] = t1
    global_angles["theta2"] = t2

    target_angles["theta1"] = t1 * GEAR_RATIO
    target_angles["theta2"] = t2 * GEAR_RATIO

shoulder_spinning = False
elbow_spinning = False

def control_loop():
    global shoulder_spinning, elbow_spinning

    while True:
        if stop_requested:
            shoulder_motor.stop(COAST)
            elbow_motor.stop(COAST)
            return

        err1 = target_angles["theta1"] - shoulder_motor.position(DEGREES)
        err2 = target_angles["theta2"] - elbow_motor.position(DEGREES)

        # --- Shoulder: independent proportional speed, no cross-motor ratio ---
        if abs(err1) < DEADBAND_DEG:
            signed_v1 = 0
        else:
            speed1 = min(MAX_VELOCITY, max(MIN_VELOCITY, abs(err1) * KP))
            signed_v1 = speed1 * 2 if err1 > 0 else -speed1 * 2

        shoulder_motor.set_velocity(signed_v1, PERCENT)
        if not shoulder_spinning:
            shoulder_motor.spin(FORWARD)
            shoulder_spinning = True

        # --- Elbow: same, independent ---
        if abs(err2) < DEADBAND_DEG:
            signed_v2 = 0
        else:
            speed2 = min(MAX_VELOCITY, max(MIN_VELOCITY, abs(err2) * KP))
            signed_v2 = speed2 if err2 > 0 else -speed2

        elbow_motor.set_velocity(signed_v2, PERCENT)
        if not elbow_spinning:
            elbow_motor.spin(FORWARD)
            elbow_spinning = True

        wait(10, MSEC)

Thread(control_loop)

def gripper_loop():
    # Drives the gripper to whatever grip_closed currently says. Closing is a
    # torque-limited move onto the object rather than a position it must reach,
    # so an object of any size is gripped by the same command; once motion
    # stops the torque drops to GRIP_HOLD_TORQUE_PCT so the motor isn't held at
    # full squeeze for as long as the object is carried.
    last_cmd = None
    stalled = False
    low_ticks = 0

    while True:
        if stop_requested:
            gripper_motor.stop(HOLD)
            return

        want_closed = grip_closed

        if want_closed != last_cmd:
            last_cmd = want_closed
            stalled = False
            low_ticks = 0
            gripper_motor.set_max_torque(GRIP_TORQUE_PCT, PERCENT)
            gripper_motor.spin_to_position(
                GRIP_CLOSED_DEG if want_closed else GRIP_OPEN_DEG,
                DEGREES, wait=False)

        # Only de-rate while closing: a stalled *open* means something is
        # jammed in the jaws, and backing off the torque there wouldn't help.
        if want_closed and not stalled:
            if abs(gripper_motor.velocity(PERCENT)) < 5:
                low_ticks += 1
                if low_ticks >= GRIP_STALL_TICKS:
                    stalled = True
                    gripper_motor.set_max_torque(GRIP_HOLD_TORQUE_PCT, PERCENT)
            else:
                low_ticks = 0

        wait(20, MSEC)

Thread(gripper_loop)

def telemetry_loop():
    # "E,q1,q2,c1,c2" at 20 Hz: measured and commanded arm-frame angles in
    # degrees. print() goes out the USB user port, same link stdin reads from.
    while True:
        if stop_requested:
            return
        q1 = shoulder_motor.position(DEGREES) / GEAR_RATIO
        q2 = elbow_motor.position(DEGREES) / GEAR_RATIO
        c1 = target_angles["theta1"] / GEAR_RATIO
        c2 = target_angles["theta2"] / GEAR_RATIO
        print("E,%.2f,%.2f,%.2f,%.2f" % (q1, q2, c1, c2))
        wait(50, MSEC)

Thread(telemetry_loop)

def screen_loop():
    # Screen redraws are slow; keep them off the serial-consuming loop and at 4 Hz.
    while True:
        if stop_requested:
            return
        brain.screen.clear_screen()
        brain.screen.set_cursor(1, 1)
        brain.screen.print("q1 %.1f  q2 %.1f" %
                           (shoulder_motor.position(DEGREES) / GEAR_RATIO,
                            elbow_motor.position(DEGREES) / GEAR_RATIO))
        brain.screen.set_cursor(2, 1)
        brain.screen.print("grip " + ("CLOSED" if grip_closed else "open")
                           + "  %.0f deg" % gripper_motor.position(DEGREES))
        wait(250, MSEC)

Thread(screen_loop)

while True:
    data = sys.stdin.readline().strip()
    if data and not reset_requested:
        parts = data.split(",")
        try:
            if len(parts) == 3:
                x = float(parts[0])     # 0.0 to 1.0
                y = float(parts[1])     # 0.0 to 1.0
                grip_closed = int(parts[2]) == 1  # gripper_loop acts on this

                go_to(x, y)
        except:
            pass
    wait(20, MSEC)
