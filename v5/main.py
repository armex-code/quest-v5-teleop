# V5 brain program — Quest teleop target (VEXcode V5 Python, deploy from VEXcode).
#
# Based on the user's proven khatt-bot program (khatt-bot-main/graphical_replica/
# src/main.py): same IK, same motor config, same gear ratio, same workspace
# mapping. Two additions for the digital twin:
#   1. Telemetry: prints "E,q1,q2,c1,c2\n" over USB serial at 20 Hz
#      (q = measured arm-frame angles from encoders, c = last commanded), which
#      server/run.py forwards to the Quest.
#   2. Pen flag from the incoming frames is stored (servo not fitted right now).
#
# Serial input (from server/run.py), one line per frame at <= 25 Hz:
#   "<x_norm>,<y_norm>,<pen>\n"   e.g. "0.512300,0.480010,1"
from vex import *
import math
import random
import sys

brain = Brain()

kill_switch = Bumper(brain.three_wire_port.a)
reset_switch = Bumper(brain.three_wire_port.b)

shoulder_motor = Motor(Ports.PORT1, GearSetting.RATIO_36_1, True)
elbow_motor = Motor(Ports.PORT4, GearSetting.RATIO_18_1, False)

GEAR_RATIO = 84 / 12  # external gear ratio = 7
L_SHOULDER = 20.5
L_ELBOW = 30.5

shoulder_motor.reset_position()
elbow_motor.reset_position()

stop_requested = False
reset_requested = False

def watch_kill_switch():
    global stop_requested
    while True:
        if kill_switch.pressing():
            stop_requested = True
            shoulder_motor.stop(BRAKE)
            elbow_motor.stop(BRAKE)
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

    init_t1 = theta1_init if theta1_init is not None else math.atan2(y_target, x_target)
    init_t2 = theta2_init if theta2_init is not None else 0.1

    best = attempt(init_t1, init_t2)
    if best[2]:
        return math.degrees(best[0]), math.degrees(best[1])

    for _ in range(num_restarts):
        t1 = random.uniform(-math.pi, math.pi)
        t2 = random.uniform(-math.pi, math.pi)
        result = attempt(t1, t2)
        if result[2]:
            return math.degrees(result[0]), math.degrees(result[1])

    brain.screen.clear_screen()
    brain.screen.set_cursor(1, 1)
    brain.screen.print("IK did not converge for target(", x_target, ",", y_target, ")")
    return None  # signal failure clearly instead of silently returning (0,0)

def normalized_to_workspace(x_norm, y_norm):
    X_MIN, X_MAX = -10.5, 10.5
    Y_MIN, Y_MAX = 18, 48
    x_norm = max(0.0, min(1.0, x_norm))
    y_norm = max(0.0, min(1.0, y_norm))

    x = X_MIN + y_norm * (X_MAX - X_MIN)
    y = Y_MIN + x_norm * (Y_MAX - Y_MIN)

    return x, y

target_angles = {"theta1": 0.0, "theta2": 0.0}
pen_down = False

MAX_VELOCITY = 70
MIN_VELOCITY = 8
DEADBAND_DEG = 3.0
KP = 0.3

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
        brain.screen.print("pen " + ("DOWN" if pen_down else "up"))
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
                pen_down = int(parts[2]) == 1   # stored; servo not fitted yet

                go_to(x, y)
        except:
            pass
    wait(20, MSEC)
