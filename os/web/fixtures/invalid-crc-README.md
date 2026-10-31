`invalid-crc.zip` contains only two short synthetic text payloads named after
required DAT files, never original Fallout data. The first stored payload was
changed after ZIP creation without updating its CRC. It must always fail import
and must never activate. Import tests use it to check that a damaged archive
leaves the previous installation in place.
