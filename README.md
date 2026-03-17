# SPS30 nodejs

regular: 
_b (same as python, works)

fanclean:

node sps30_c.mjs -p /dev/cu.usbserial-440 --clean

# Dragino like

sps30-raw-test.mjs
(as per https://claude.ai/chat/b9e0843a-5449-43b7-80ca-523d04bf3002)


# Different commands

node sps30_e_commands.mjs info
node sps30_e_commands.mjs measure -n 10 -i 2000
node sps30_e_commands.mjs clean
node sps30_e_commands.mjs get-clean-interval
node sps30_e_commands.mjs set-clean-interval 86400
node sps30_e_commands.mjs sleep
node sps30_e_commands.mjs wake
node sps30_e_commands.mjs reset

# Pinout (wrong colours @ cable)

https://github.com/Sensirion/embedded-uart-sps30/blob/main/images/product-pinout-sps30.jpg

# Internal code

https://github.com/Sensirion/embedded-uart-sps/blob/master/sps30-uart/sps30.c