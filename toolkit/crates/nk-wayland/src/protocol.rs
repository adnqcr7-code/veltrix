// SPDX-License-Identifier: LGPL-3.0-or-later
//! Generated from the same XML as Hyalo. No copied protocol declarations.
#[allow(clippy::all)]
pub mod material {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../../protocols/veltrix-material-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("../../../protocols/veltrix-material-v1.xml");
}

#[allow(clippy::all)]
pub mod layers {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../../protocols/veltrix-layers-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("../../../protocols/veltrix-layers-v1.xml");
}

#[allow(clippy::all)]
pub mod controls {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../../protocols/veltrix-window-controls-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("../../../protocols/veltrix-window-controls-v1.xml");
}

#[allow(clippy::all)]
pub mod drag_feedback {
    const _: &[u8] = include_bytes!("../../../../protocols/veltrix-drag-feedback-v1.xml");
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../../protocols/veltrix-drag-feedback-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("../../../protocols/veltrix-drag-feedback-v1.xml");
}
