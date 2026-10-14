use std::io;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::{Engine, EngineEvent};
use crate::terminal::{Mods, Mouse, MouseButton, MouseKind, TOUCH_TIME_MASK, Touch, TouchKind};
use crate::tree::{NodeId, PxRect};

const CLOCK_RESYNC_MS: f64 = 1000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TouchPoint {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Node(usize, NodeId),
    Mouse(u32),
}

#[derive(Default)]
pub(super) struct Touches {
    target: Option<Target>,
    points: Vec<(u32, (f32, f32))>,
    clock: TouchClock,
}

impl Touches {
    fn track(&mut self, kind: TouchKind, id: u32, point: (f32, f32)) -> bool {
        let at = self.points.iter().position(|&(known, _)| known == id);
        match (kind, at) {
            (TouchKind::Down, Some(at)) | (TouchKind::Move, Some(at)) => {
                self.points[at].1 = point;
                true
            }
            (TouchKind::Down, None) => {
                self.points.push((id, point));
                true
            }
            (TouchKind::Up, Some(at)) => {
                self.points.remove(at);
                true
            }
            (TouchKind::Cancel, _) if !self.points.is_empty() => {
                self.points.clear();
                true
            }
            _ => false,
        }
    }
}

#[derive(Default)]
struct TouchClock {
    last: Option<(u32, f64)>,
}

impl TouchClock {
    // Chromium reads touch timestamps as wall-clock time, so the terminal's
    // millisecond counter is pinned to it and only its differences are kept.
    fn stamp(&mut self, raw: u32, now_ms: f64) -> f64 {
        let stamp = match self.last {
            Some((last_raw, last_ms)) => {
                let advanced = last_ms + f64::from(raw.wrapping_sub(last_raw) & TOUCH_TIME_MASK);
                if (advanced - now_ms).abs() > CLOCK_RESYNC_MS {
                    now_ms.max(last_ms)
                } else {
                    advanced
                }
            }
            None => now_ms,
        };
        self.last = Some((raw, stamp));
        stamp
    }
}

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl Engine {
    pub(super) fn handle_touch(
        &mut self,
        touch: Touch,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let point = (touch.x as f32, touch.y as f32);
        let time = self.touches.clock.stamp(touch.time, epoch_ms());
        if touch.kind == TouchKind::Down && self.touches.points.is_empty() {
            self.touches.target = Some(self.touch_target(touch.id, point));
        }
        if !self.touches.track(touch.kind, touch.id, point) {
            return Ok(());
        }
        let target = self.touches.target;
        if self.touches.points.is_empty() {
            self.touches.target = None;
        }
        match target {
            Some(Target::Node(view, node)) => {
                if matches!(touch.kind, TouchKind::Down | TouchKind::Up) {
                    self.focus_click = None;
                    self.last_pointer_click = Some(Instant::now());
                }
                self.emit_touch(view, node, touch, point, time, out);
            }
            Some(Target::Mouse(primary)) if primary == touch.id || touch.kind == TouchKind::Cancel => {
                let kind = match touch.kind {
                    TouchKind::Down => MouseKind::Down,
                    TouchKind::Move => MouseKind::Move,
                    TouchKind::Up => MouseKind::Up,
                    TouchKind::Cancel => {
                        self.pending_click = None;
                        MouseKind::Up
                    }
                };
                self.handle_mouse(
                    Mouse {
                        kind,
                        button: MouseButton::Left,
                        mods: Mods::default(),
                        x: touch.x,
                        y: touch.y,
                    },
                    out,
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    fn touch_target(&mut self, id: u32, point: (f32, f32)) -> Target {
        if self.drag.is_some() {
            return Target::Mouse(id);
        }
        let view = self.comp.view_at(point.0);
        let local = self.comp.to_local(view, point);
        let Some(node) = self.comp.views[view].tree.hit_touch(local.0, local.1) else {
            return Target::Mouse(id);
        };
        self.active_view = view;
        self.set_focus(view, None);
        self.key_passthrough = true;
        Target::Node(view, node)
    }

    fn emit_touch(
        &mut self,
        view: usize,
        node: NodeId,
        touch: Touch,
        point: (f32, f32),
        time: f64,
        out: &mut Vec<EngineEvent>,
    ) {
        let rect = self.comp.views[view]
            .tree
            .rect(node)
            .unwrap_or(PxRect::ZERO);
        let in_node = |point: (f32, f32)| {
            let local = self.comp.to_local(view, point);
            (local.0 - rect.x, local.1 - rect.y)
        };
        let (x, y) = in_node(point);
        let points = self
            .touches
            .points
            .iter()
            .map(|&(id, point)| {
                let (x, y) = in_node(point);
                TouchPoint { id, x, y }
            })
            .collect();
        out.push(EngineEvent::Touch {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            kind: touch.kind,
            id: touch.id,
            x,
            y,
            time,
            points,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(touches: &Touches) -> Vec<u32> {
        touches.points.iter().map(|&(id, _)| id).collect()
    }

    #[test]
    fn tracks_every_finger_that_is_down() {
        let mut touches = Touches::default();
        assert!(touches.track(TouchKind::Down, 4, (1.0, 1.0)));
        assert!(touches.track(TouchKind::Down, 9, (5.0, 5.0)));
        assert_eq!(ids(&touches), [4, 9]);
        assert!(touches.track(TouchKind::Move, 9, (6.0, 7.0)));
        assert_eq!(touches.points[1], (9, (6.0, 7.0)));
        assert!(touches.track(TouchKind::Up, 4, (1.0, 1.0)));
        assert_eq!(ids(&touches), [9]);
        assert!(touches.track(TouchKind::Up, 9, (6.0, 7.0)));
        assert!(touches.points.is_empty());
    }

    #[test]
    fn ignores_fingers_it_never_saw_go_down() {
        let mut touches = Touches::default();
        assert!(!touches.track(TouchKind::Move, 1, (1.0, 1.0)));
        assert!(!touches.track(TouchKind::Up, 1, (1.0, 1.0)));
        assert!(!touches.track(TouchKind::Cancel, 1, (1.0, 1.0)));
        assert!(touches.points.is_empty());
    }

    #[test]
    fn a_repeated_down_moves_the_finger_instead_of_adding_one() {
        let mut touches = Touches::default();
        touches.track(TouchKind::Down, 2, (1.0, 1.0));
        touches.track(TouchKind::Down, 2, (3.0, 3.0));
        assert_eq!(touches.points, [(2, (3.0, 3.0))]);
    }

    #[test]
    fn the_first_cancel_ends_every_finger() {
        let mut touches = Touches::default();
        touches.track(TouchKind::Down, 1, (1.0, 1.0));
        touches.track(TouchKind::Down, 2, (2.0, 2.0));
        assert!(touches.track(TouchKind::Cancel, 2, (2.0, 2.0)));
        assert!(touches.points.is_empty());
        assert!(!touches.track(TouchKind::Cancel, 1, (1.0, 1.0)));
    }

    #[test]
    fn the_clock_starts_at_now_and_keeps_the_terminals_spacing() {
        let mut clock = TouchClock::default();
        assert_eq!(clock.stamp(5_000, 1_000_000.0), 1_000_000.0);
        assert_eq!(clock.stamp(5_016, 1_000_030.0), 1_000_016.0);
        assert_eq!(clock.stamp(5_032, 1_000_031.0), 1_000_032.0);
    }

    #[test]
    fn the_clock_runs_on_through_a_wrap_of_the_31_bit_counter() {
        let mut clock = TouchClock::default();
        clock.stamp(0x7fff_fff0, 2_000_000.0);
        assert_eq!(clock.stamp(0x10, 2_000_032.0), 2_000_032.0);
        assert_eq!(clock.stamp(0x20, 2_000_048.0), 2_000_048.0);
    }

    #[test]
    fn the_clock_resyncs_after_drifting_without_going_back() {
        let mut clock = TouchClock::default();
        clock.stamp(100, 3_000_000.0);
        assert_eq!(
            clock.stamp(200, 3_600_000.0),
            3_600_000.0,
            "a counter that stood still while the device slept"
        );
        assert_eq!(
            clock.stamp(50, 3_600_010.0),
            3_600_010.0,
            "a counter that jumped backwards"
        );
        assert_eq!(clock.stamp(60, 3_600_020.0), 3_600_020.0);
    }
}
