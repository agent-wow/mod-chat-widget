# AzerothCore builds this module through its modules/ source discovery.
# Keep tests outside src/ so production builds never require Google Test.
include("${CMAKE_CURRENT_LIST_DIR}/mod-chat-widget.cmake")
