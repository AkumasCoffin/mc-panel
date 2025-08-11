package net.minecraftforge.fml.common;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Mod annotation interface for Forge compatibility.
 * This allows the mod to compile without full Forge dependencies
 * while still providing the required @Mod annotation that Forge expects.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface Mod {
    /**
     * The mod ID for this mod.
     * @return the mod ID
     */
    String value();
}