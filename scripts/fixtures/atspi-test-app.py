#!/usr/bin/env python3
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

GLib.set_prgname("chatgpt-computer-semantic-test")
GLib.set_application_name("ChatGPT Computer Semantic Test")

window = Gtk.Window(title="ChatGPT Computer Semantic Test")
window.set_default_size(480, 220)
window.set_border_width(24)
window.connect("destroy", Gtk.main_quit)

box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
window.add(box)

entry = Gtk.Entry()
entry.set_placeholder_text("Semantic input")
entry.get_accessible().set_name("Semantic entry")
box.pack_start(entry, False, False, 0)

button = Gtk.Button(label="Apply semantic value")
button.get_accessible().set_name("Apply semantic value")
box.pack_start(button, False, False, 0)

status = Gtk.Label(label="idle")
status.get_accessible().set_name("Semantic status")
box.pack_start(status, False, False, 0)

button.connect("clicked", lambda _button: status.set_text(f"clicked:{entry.get_text()}"))
window.show_all()
Gtk.main()
