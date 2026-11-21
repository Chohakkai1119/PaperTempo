"""Reduce OMR MusicXML to the monophonic top line PaperTempo can follow."""

from __future__ import annotations

import collections
import sys
import xml.etree.ElementTree as ET


def local_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def prepare(source: str, destination: str) -> None:
    tree = ET.parse(source)
    root = tree.getroot()
    if local_name(root) != "score-partwise":
        raise ValueError("PaperTempo needs a partwise MusicXML score.")

    parts = [element for element in root if local_name(element) == "part"]
    if not parts:
        raise ValueError("The OMR result contains no score part.")
    part = parts[0]
    notes = [element for element in part.iter() if local_name(element) == "note"]
    voice_counts = collections.Counter(
        (note.findtext("staff") or "1", note.findtext("voice") or "1")
        for note in notes
        if (note.findtext("staff") or "1") == "1"
        and note.find("grace") is None
        and note.find("unpitched") is None
    )
    if not voice_counts:
        raise ValueError("The OMR result contains no notes on its first staff.")
    selected_staff, selected_voice = voice_counts.most_common(1)[0][0]

    for child in list(root):
        if local_name(child) == "part" and child is not part:
            root.remove(child)
        elif local_name(child) == "part-list":
            score_parts = [item for item in child if local_name(item) == "score-part"]
            for item in score_parts[1:]:
                child.remove(item)
            if score_parts:
                name = next((item for item in score_parts[0] if local_name(item) == "part-name"), None)
                if name is not None:
                    name.text = "Melody"

    kept_notes = 0
    for measure in [element for element in part if local_name(element) == "measure"]:
        for element in list(measure):
            tag = local_name(element)
            if tag in {"backup", "forward"}:
                measure.remove(element)
            elif tag == "attributes":
                for setting in list(element):
                    if local_name(setting) in {"staves", "part-symbol"}:
                        element.remove(setting)
                    elif local_name(setting) == "clef":
                        if setting.get("number", "1") != "1":
                            element.remove(setting)
                        else:
                            setting.attrib.pop("number", None)
            elif tag == "barline":
                for repeat in list(element):
                    if local_name(repeat) == "repeat":
                        element.remove(repeat)
            elif tag == "note":
                staff = element.findtext("staff") or "1"
                voice = element.findtext("voice") or "1"
                if (
                    staff != selected_staff
                    or voice != selected_voice
                    or element.find("chord") is not None
                    or element.find("grace") is not None
                    or element.find("unpitched") is not None
                ):
                    measure.remove(element)
                    continue
                for metadata in list(element):
                    if local_name(metadata) in {"staff", "voice"}:
                        element.remove(metadata)
                if element.find("duration") is None or (element.find("pitch") is None and element.find("rest") is None):
                    measure.remove(element)
                    continue
                kept_notes += 1

    if kept_notes == 0:
        raise ValueError("The OMR result has no readable notes on its first staff.")
    tree.write(destination, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: prepare_melody.py input.musicxml output.musicxml")
    prepare(sys.argv[1], sys.argv[2])
