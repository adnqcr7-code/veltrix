// SPDX-License-Identifier: LGPL-3.0-or-later
//! Claude's named builders of Appearance (#915): `nightScheduleTimes`,
//! after `ui/shell/surfaces/settings/custom/appearance.ts`. Sol's (wallpaper, fonts,
//! dropdown) live in their own modules.
//!
//! The `accentPicker` builder was deleted with the cyan-only decision
//! (2026-11-12): one accent, no picker, nothing to build.

use crate::manifest::Item;
use crate::render::{Builder, Builders, Built, Cx, Result};
use crate::session::Notice;
use crate::value::Value;
use nk_widgets::{Effect, NodeId, ValueRange};

/// Registers this module's builders.
pub fn register(builders: &mut Builders) {
    builders.register("nightScheduleTimes", || Box::new(ScheduleTimes::default()));
}


const FROM: &str = "nightlight.scheduleFrom";
const TO: &str = "nightlight.scheduleTo";

/// The schedule's two times, "Turn on at" and "Turn off at", each an hour and a minute that
/// wrap like a clock's, written back as `HH:MM` (the service's own `isTime`).
#[derive(Default)]
pub struct ScheduleTimes {
    /// Per key: its row, its hour spin, its minute spin.
    times: Vec<(String, NodeId, NodeId, NodeId)>,
}

fn parse_time(v: Option<&Value>) -> Option<(f32, f32)> {
    let (h, m) = v?.as_text()?.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some((h as f32, m as f32))
}

fn clock(max: f32) -> ValueRange {
    ValueRange {
        min: 0.,
        max,
        step: 1.,
        wrap: true,
        digits: 2,
        decimals: 0,
        unit: String::new(),
    }
}

impl Builder for ScheduleTimes {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, _item: &Item) -> Result<Built> {
        let hour = cx.exports.text("settings.appearance.time.hour")?.to_owned();
        let minute = cx
            .exports
            .text("settings.appearance.time.minute")?
            .to_owned();
        for (key, label) in [
            (FROM, "settings.appearance.night-light-from"),
            (TO, "settings.appearance.night-light-to"),
        ] {
            let label = cx.exports.text(label)?.to_owned();
            let (h, m) = parse_time(cx.session().shown(key)).unwrap_or((0., 0.));
            let (row, fields, spins) = cx.tree.fields(
                group,
                &label,
                vec![
                    (&format!("{label}, {hour}"), clock(23.), h),
                    (&format!("{label}, {minute}"), clock(59.), m),
                ],
            )?;
            for id in [row, fields].iter().chain(&spins) {
                cx.own(*id);
            }
            self.times.push((key.to_owned(), row, spins[0], spins[1]));
        }
        Ok(Built {
            rows: self.times.iter().map(|t| t.1).collect(),
            keys: vec![FROM.into(), TO.into()],
        })
    }

    fn notice(&mut self, cx: &mut Cx<'_>, _notice: &Notice) -> Result<()> {
        for (key, _, h, m) in &self.times {
            if let Some((hv, mv)) = parse_time(cx.session().shown(key)) {
                cx.tree.set_value(*h, hv)?;
                cx.tree.set_value(*m, mv)?;
            }
        }
        Ok(())
    }

    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        let Effect::Changed(id) = effect else {
            return Ok(());
        };
        let Some((key, _, h, m)) = self
            .times
            .iter()
            .find(|(_, _, h, m)| *h == id || *m == id)
            .cloned()
        else {
            return Ok(());
        };
        let (hv, mv) = (
            cx.tree.value(h).ok_or("an hour without value")?,
            cx.tree.value(m).ok_or("a minute without value")?,
        );
        let text = format!("{:02}:{:02}", hv as u32, mv as u32);
        // A refusal before sending (the service gone) is the rows' insensitivity already;
        // a refusal answered comes back as a notice and the next one shows the time in force.
        let _ = cx.apply(&key, Value::Text(text));
        Ok(())
    }
}
