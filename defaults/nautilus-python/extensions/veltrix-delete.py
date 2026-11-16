# SPDX-License-Identifier: GPL-3.0-or-later
"""Veltrix — "Move to Trash…" in Files' right-click menu.

Files (Nautilus) has no visible Delete button and nothing in the toolbar says
how to delete: the only built-in ways are the Delete key and a "Move to Trash"
row buried in the right-click menu, and neither is discoverable if nobody tells
you. This extension adds one explicit row, top of the file menu, that always
asks first.

Safety, deliberately:
  * It moves to the Trash — never a permanent delete. What goes in can be
    restored from Trash, and the dialog says so. (Nautilus' own
    "Delete Permanently" is a different row, behind the
    `org.gnome.nautilus.preferences show-delete-permanently` key, and this
    extension does not turn it on.)
  * It asks before it acts, naming what will move, and it reports the files it
    could NOT move instead of failing silently.
  * Inside the Trash itself it offers nothing: there Nautilus already has
    Restore / Delete Permanently, and a second "Move to Trash" would be a lie.

Requires nautilus-python (Arch: `nautilus-python`, the `nautilus-python`
package — without it this file is inert, which is why the package lists it)
and GTK >= 4.10 (Gtk.AlertDialog). Loads when Files starts; after installing,
restart Files (`nautilus -q`) for it to appear. Installed per user at
~/.local/share/nautilus-python/extensions/ by veltrix-setup, seeded only when
absent — a user's own extension of the same name is never overwritten.
"""

import gi

gi.require_version("Nautilus", "4.0")
gi.require_version("Gtk", "4.0")

from gi.repository import GLib, GObject, Gtk, Nautilus

MENU_NAME = "VeltrixDeleteExtension::MoveToTrash"
MENU_LABEL = "Move to Trash…"
MENU_TIP = "Move the selected items to the Trash (Delete key does the same)"


def _is_trashable(fileinfo):
    """False for items already in the Trash (nothing to move) and for items with
    no local path to trash — anything else is offered the menu row."""
    try:
        if fileinfo.get_uri_scheme() == "trash":
            return False
        return fileinfo.get_location() is not None
    except Exception:
        return False


def _describe_selection(files):
    """The confirmation dialog's (message, detail) for `files`."""
    if len(files) == 1:
        message = "Move “%s” to the Trash?" % files[0].get_name()
    else:
        message = "Move %d items to the Trash?" % len(files)
    detail = "You can restore them from Trash. This does not delete them permanently."
    return message, detail


def _trash_files(files):
    """Move each file to the Trash. Returns (trashed, failed_names): a file that
    cannot be trashed (read-only location, a volume with no trash) is skipped
    and named, never silently dropped, and never deleted another way."""
    trashed = 0
    failed = []
    for fileinfo in files:
        try:
            if fileinfo.get_location().trash(None):
                trashed += 1
            else:
                failed.append(fileinfo.get_name())
        except GLib.Error:
            failed.append(fileinfo.get_name())
    return trashed, failed


class VeltrixDeleteExtension(GObject.GObject, Nautilus.MenuProvider):
    def __init__(self):
        super().__init__()

    def get_file_items(self, files):
        trashable = [f for f in files if _is_trashable(f)]
        if not trashable:
            return []
        item = Nautilus.MenuItem(name=MENU_NAME, label=MENU_LABEL, tip=MENU_TIP)
        item.connect("activate", self._on_activate, trashable)
        return [item]

    def _on_activate(self, _menu, files):
        message, detail = _describe_selection(files)
        dialog = Gtk.AlertDialog(message=message, detail=detail)
        dialog.set_buttons(["Cancel", "Move to Trash"])
        dialog.set_cancel_button(0)
        dialog.set_default_button(1)
        dialog.choose(None, None, self._on_confirm, files)

    def _on_confirm(self, dialog, result, files):
        try:
            choice = dialog.choose_finish(result)
        except GLib.Error:
            return  # dismissed; nothing was moved
        if choice != 1:
            return  # Cancel, or the dialog closed another way
        _trashed, failed = _trash_files(files)
        if failed:
            detail = "Could not move: %s." % ", ".join("“%s”" % n for n in failed)
            problem = Gtk.AlertDialog(
                message="Some items could not be moved to the Trash.",
                detail=detail,
            )
            problem.set_buttons(["OK"])
            problem.set_default_button(0)
            problem.choose(None, None, None)
