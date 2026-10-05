# The core discovers src/ and calls Addmod_chat_loggerScripts automatically.
include_guard(GLOBAL)

if(BUILD_TESTING AND NOT MODULE_MOD-CHAT-LOGGER STREQUAL "disabled")
  set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_SOURCES
    "${CMAKE_CURRENT_LIST_DIR}/tests/ChatLoggerEventTest.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/tests/ChatLoggerDeliveryTest.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/tests/ChatLoggerHttpTest.cpp")
  set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_INCLUDES
    "${CMAKE_CURRENT_LIST_DIR}/src")

  # Dynamic module symbols are private. Compile the non-hook components into tests in this mode.
  if(MODULE_MOD-CHAT-LOGGER STREQUAL "dynamic")
    set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_SOURCES
      "${CMAKE_CURRENT_LIST_DIR}/src/ChatLoggerEvent.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/ChatLoggerDelivery.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/ChatLoggerHttp.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/ChatLoggerRunner.cpp")
  endif()
endif()
